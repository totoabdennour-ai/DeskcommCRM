/**
 * O ENGINE DO PEDIDO — a casca de IO que amarra resolver + RPCs transacionais.
 *
 * ─── Fluxo (doc 25, defaults aprovados) ─────────────────────────────────────
 *
 * 1. `criarRascunho`: resolve CADA linha no resolver (A1–A5) → monta os
 *    snapshots vivos → `fn_criar_pedido` grava pedido+linhas+evento NO MESMO
 *    COMMIT (outbox — doc 07 §6). Linha sem preço (`no_price`) RECUSA o
 *    pedido inteiro com o motivo (nunca preço inventado).
 * 2. `confirmar`: RE-RESOLVE todas as linhas (A6 — o snapshot vale no
 *    instante da confirmação) → `fn_confirmar_pedido` substitui as linhas,
 *    recalcula o total e congela. Cliente viu o preço vivo na conversa até o
 *    "sim"; o confirmado nunca se move.
 * 3. `editarRascunho`: só draft, re-resolve tudo (preço vivo do rascunho).
 * 4. `cancelar`: draft|confirmed → cancelled, com motivo no evento.
 *
 * Quem chama: as rotas REST (operador, com requireRole) e as tools MCP do
 * agente (Fase 5 — criar RASCUNHO apenas; confirmar é rota de operador, B1).
 * Todas as entradas chegam com organizationId de fonte confiável.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { consultarPreco } from "@/lib/pricing/consultar";
import type { InstantaneoDePreco } from "@/lib/pricing/resolver";
import { numeroExternoNativo, totalDasLinhas, type AtorDoPedido, type LinhaPedido } from "./tipos";

export interface LinhaResolvida extends InstantaneoDePreco {
  quantity: number;
}

export type ResultadoDaResolucao =
  | { ok: true; linhas: LinhaResolvida[]; total_cents: number }
  | { ok: false; motivo: string; produto: { codigo: string; nome: string } | null };

/**
 * Resolve todas as linhas de um pedido. UMA linha sem preço recusa o PEDIDO
 * inteiro (fail-closed — doc 24; nunca pedido parcial com preço inventado).
 * Moeda: todas as linhas têm de compartilhar a MESMA moeda (A4 — o pedido é
 * em uma moeda; a da organização no estado atual).
 */
export async function resolverLinhas(
  supabase: SupabaseClient,
  entrada: {
    organizationId: string;
    accountId: string;
    linhas: LinhaPedido[];
  },
): Promise<ResultadoDaResolucao> {
  const linhas: LinhaResolvida[] = [];
  const agora = new Date();
  let moeda: string | null = null;

  for (const linha of entrada.linhas) {
    const r = await consultarPreco(supabase, {
      organizationId: entrada.organizationId,
      productId: linha.product_id,
      accountId: entrada.accountId,
      quantidade: linha.quantity,
    });
    if (r.status === "no_price") {
      return {
        ok: false,
        motivo: r.motivo,
        produto: r.produto ? { codigo: r.produto.codigo, nome: r.produto.nome } : null,
      };
    }
    if (moeda === null) moeda = r.moeda;
    if (r.moeda !== moeda) {
      return {
        ok: false,
        motivo: "moeda_mista",
        produto: { codigo: r.produto.codigo, nome: r.produto.nome },
      };
    }
    linhas.push({
      product_id: r.produto.id,
      sku: r.produto.codigo,
      nome: r.produto.nome,
      unit_price_cents: r.unit_price_cents,
      moeda: r.moeda,
      fonte: r.fonte,
      price_list_id: r.price_list_id,
      price_list_item_id: r.price_list_item_id,
      resolvido_em: agora.toISOString(),
      quantity: linha.quantity,
    });
  }

  return { ok: true, linhas, total_cents: totalDasLinhas(linhas.map((l) => ({ unit_price_cents: l.unit_price_cents, quantity: l.quantity }))) };
}

/** Linhas no formato jsonb que as RPCs (0241) consomem. */
export function linhasParaRpc(linhas: readonly LinhaResolvida[]): Record<string, unknown>[] {
  const agora = new Date().toISOString();
  return linhas.map((l) => ({
    product_id: l.product_id,
    sku: l.sku,
    nome: l.nome,
    unit_price_cents: l.unit_price_cents,
    moeda: l.moeda,
    fonte: l.fonte,
    price_list_id: l.price_list_id,
    price_list_item_id: l.price_list_item_id,
    resolvido_em: l.resolvido_em ?? agora,
  }));
}

export interface PedidoCriado {
  /** `true` = chave idempotente já consumida: devolvemos o resultado GRAVADO. */
  replay: boolean;
  order_id: string;
  external_id: string;
  status: "draft";
  total_cents: number;
  /** Preenchido só quando NÃO é replay (o replay devolve o resultado gravado). */
  linhas: LinhaResolvida[];
}

export async function criarRascunho(
  supabase: SupabaseClient,
  entrada: {
    organizationId: string;
    accountId: string;
    linhas: LinhaPedido[];
    actorUserId: string | null;
    actorKind: AtorDoPedido;
    externalId: string | null;
    /** Idempotência TRANSACIONAL (F4.1): consumida DENTRO de fn_criar_pedido. */
    idempotencyKey?: string;
    requestHash?: string;
  },
): Promise<
  | { ok: true; pedido: PedidoCriado }
  | { ok: false; motivo: string; produto: { codigo: string; nome: string } | null }
> {
  const resolucao = await resolverLinhas(supabase, {
    organizationId: entrada.organizationId,
    accountId: entrada.accountId,
    linhas: entrada.linhas,
  });
  if (!resolucao.ok) return resolucao;

  const external_id =
    entrada.externalId ?? numeroExternoNativo(new Date(), crypto.randomUUID());

  const { data, error } = await supabase.rpc("fn_criar_pedido", {
    p_org: entrada.organizationId,
    p_account: entrada.accountId,
    p_external_id: external_id,
    p_moeda: resolucao.linhas[0]!.moeda,
    p_items: linhasParaRpc(resolucao.linhas),
    p_actor: entrada.actorUserId,
    p_actor_kind: entrada.actorKind,
    p_key: entrada.idempotencyKey ?? "",
    p_request_hash: entrada.requestHash
      ? Buffer.from(entrada.requestHash, "hex")
      : null,
  });
  if (error) {
    throw new Error(`fn_criar_pedido: ${error.message}`);
  }

  const resultado = data as {
    replay: boolean;
    order_id: string;
    external_id: string;
    status: "draft";
    total_cents: number;
  };

  return {
    ok: true,
    pedido: {
      replay: resultado.replay === true,
      order_id: resultado.order_id,
      external_id: resultado.external_id,
      status: "draft",
      total_cents: resultado.total_cents,
      // Replay devolve o resultado gravado — as linhas frescas NÃO são
      // apresentadas como se tivessem sido re-inseridas.
      linhas: resultado.replay === true ? [] : resolucao.linhas,
    },
  };
}

export async function confirmar(
  supabase: SupabaseClient,
  entrada: {
    organizationId: string;
    orderId: string;
    accountId: string;
    linhas: LinhaPedido[];
    actorUserId: string | null;
    actorKind: AtorDoPedido;
  },
): Promise<{ ok: true; total_cents: number } | { ok: false; motivo: string; produto: { codigo: string; nome: string } | null }> {
  // A6: o snapshot vale no instante da CONFIRMAÇÃO — re-resolve tudo agora.
  const resolucao = await resolverLinhas(supabase, {
    organizationId: entrada.organizationId,
    accountId: entrada.accountId,
    linhas: entrada.linhas,
  });
  if (!resolucao.ok) return resolucao;

  const { error } = await supabase.rpc("fn_confirmar_pedido", {
    p_org: entrada.organizationId,
    p_order: entrada.orderId,
    p_items: linhasParaRpc(resolucao.linhas),
    p_actor: entrada.actorUserId,
    p_actor_kind: entrada.actorKind,
  });
  if (error) {
    // 23514 = estado inválido / de outra org (mensagem do banco é a verdade).
    throw new Error(`fn_confirmar_pedido: ${error.message}`);
  }
  return { ok: true, total_cents: resolucao.total_cents };
}

export async function editarRascunho(
  supabase: SupabaseClient,
  entrada: {
    organizationId: string;
    orderId: string;
    accountId: string;
    linhas: LinhaPedido[];
    actorUserId: string | null;
    actorKind: AtorDoPedido;
  },
): Promise<{ ok: true; total_cents: number } | { ok: false; motivo: string; produto: { codigo: string; nome: string } | null }> {
  const resolucao = await resolverLinhas(supabase, {
    organizationId: entrada.organizationId,
    accountId: entrada.accountId,
    linhas: entrada.linhas,
  });
  if (!resolucao.ok) return resolucao;

  const { error } = await supabase.rpc("fn_editar_rascunho", {
    p_org: entrada.organizationId,
    p_order: entrada.orderId,
    p_items: linhasParaRpc(resolucao.linhas),
    p_actor: entrada.actorUserId,
    p_actor_kind: entrada.actorKind,
  });
  if (error) {
    throw new Error(`fn_editar_rascunho: ${error.message}`);
  }
  return { ok: true, total_cents: resolucao.total_cents };
}

export async function cancelar(
  supabase: SupabaseClient,
  entrada: {
    organizationId: string;
    orderId: string;
    motivo: string;
    actorUserId: string | null;
    actorKind: AtorDoPedido;
  },
): Promise<void> {
  const { error } = await supabase.rpc("fn_cancelar_pedido", {
    p_org: entrada.organizationId,
    p_order: entrada.orderId,
    p_motivo: entrada.motivo,
    p_actor: entrada.actorUserId,
    p_actor_kind: entrada.actorKind,
  });
  if (error) {
    throw new Error(`fn_cancelar_pedido: ${error.message}`);
  }
}
