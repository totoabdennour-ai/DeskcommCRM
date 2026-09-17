/**
 * O SERVIÇO DE CONSULTA DE PREÇO — a casca de IO do resolver puro.
 *
 * ─── Por que duas camadas (`resolver.ts` + este arquivo) ────────────────────
 *
 * Mesmo molde de `lib/routing/` (`decide.ts` puro + `worker.ts` de IO): a
 * DECISÃO é testável sem banco e impossível de "vazar relógio/timestamp" —
 * o IO busca as linhas COM filtro de organização (a barreira de tenant) e o
 * puro decide. Quem consome este serviço: a rota `pricing/resolve` (hoje) e
 * o Order Engine + a tool de consulta do agente (Fase 5) — sempre AQUI,
 * nunca o catálogo cru, nunca um LLM.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  capturarInstantaneo,
  resolverPreco,
  type EntradaDaResolucao,
  type InstantaneoDePreco,
  type PrecoResolvido,
} from "./resolver";

export interface PedidoDePreco {
  organizationId: string;
  productId: string;
  /** Opcional: sem conta (ou conta sem lista), vale o preço base. */
  accountId?: string | null;
  /** Viaja para o snapshot/futuro; NÃO muda o unitário (A5). */
  quantidade?: number;
}

/**
 * Resolve o preço unitário para (org, produto, conta?) — deterministicamente.
 * Todas as leituras são org-filtradas: insumo de outra organização é linha
 * inexistente, e o resolver trata como ausência (nunca como preço).
 */
export async function consultarPreco(
  supabase: SupabaseClient,
  pedido: PedidoDePreco,
): Promise<PrecoResolvido> {
  const { organizationId, productId, accountId = null, quantidade = 1 } = pedido;

  const conta = accountId
    ? (
        await supabase
          .from("accounts")
          .select("price_list_id")
          .eq("id", accountId)
          .eq("organization_id", organizationId)
          .maybeSingle()
      ).data
    : null;

  const listaId = (conta as { price_list_id?: string | null } | null)?.price_list_id ?? null;
  const lista = listaId
    ? (
        await supabase
          .from("price_lists")
          .select("id, status, moeda")
          .eq("id", listaId)
          .eq("organization_id", organizationId)
          .maybeSingle()
      ).data
    : null;

  const item =
    listaId && lista
      ? (
          await supabase
            .from("price_list_items")
            .select("id, preco_cents")
            .eq("price_list_id", listaId)
            .eq("product_id", productId)
            .eq("organization_id", organizationId)
            .maybeSingle()
        ).data
    : null;

  const produto = (
    await supabase
      .from("catalog_products")
      .select("id, codigo, nome, preco_cents, moeda, ativo")
      .eq("id", productId)
      .eq("organization_id", organizationId)
      .maybeSingle()
  ).data;

  // A moeda da lista vai no insumo do item (o item não tem coluna de moeda —
  // a da LISTA governa, A4). O resolver confere e falha fechado se divergir.
  const insumo: EntradaDaResolucao = {
    organizationId,
    accountId,
    productId,
    quantidade,
    conta: (conta as { price_list_id: string | null } | null) ?? null,
    lista: (lista as { id: string; status: string; moeda: string } | null) ?? null,
    item: item
      ? {
          id: (item as { id: string }).id,
          preco_cents: (item as { preco_cents: number }).preco_cents,
          moeda: (lista as { moeda: string }).moeda,
        }
      : null,
    produto: (produto as EntradaDaResolucao["produto"]) ?? null,
  };

  return resolverPreco(insumo);
}

/**
 * Resolve E congela o snapshot no instante da chamada — o que o Order Engine
 * grava em `order_items` na confirmação (Fase 4). Não é usado por nenhuma
 * rota desta fase: é o contrato já pronto para o engine consumir.
 */
export async function capturarPrecoParaPedido(
  supabase: SupabaseClient,
  pedido: PedidoDePreco,
): Promise<{ preco: PrecoResolvido; instantaneo: InstantaneoDePreco | null }> {
  const preco = await consultarPreco(supabase, pedido);
  return {
    preco,
    instantaneo: preco.status === "resolved" ? capturarInstantaneo(preco, new Date()) : null,
  };
}
