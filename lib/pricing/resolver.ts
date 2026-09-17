/**
 * O RESOLVER DE PREÇO — a decisão pura, sem banco, sem relógio, sem IA.
 *
 * ─── O princípio (doc 24 §fronteira) ────────────────────────────────────────
 *
 * IA pode identificar produto, extrair quantidade e PEDIR um preço. IA NUNCA
 * é fonte de verdade de preço: nem unitário, nem desconto, nem total, nem
 * validade. Esta função é a ÚNICA que decide — e ela é determinística: os
 * mesmos insumos produzem sempre a mesma saída. O Order Engine (Fase 4) e a
 * futura tool de consulta do agente consomem AQUI, nunca o catálogo cru.
 *
 * ─── Precedência (determinística, doc 24 §2 A1–A5) ──────────────────────────
 *
 * 1. A conta (da MESMA org) aponta para uma lista ATIVA (mesma org) e a lista
 *    tem item para o produto → preço da LISTA (moeda da lista).
 * 2. Senão, o produto existe e está ativo → preço BASE do catálogo.
 * 3. Senão, `no_price` com motivo — nunca preço inventado.
 *
 * Suposições menores explícitas (decisão do dono exigida antes do Order
 * Engine): A1 ausência na lista herda o base; A2 produto inativo não tem
 * preço; A3 lista inativa é ignorada (cai ao base); A4 moeda da LISTA governa
 * o item; A5 quantidade não muda o unitário nesta fase.
 */

export type FonteDePreco = "price_list" | "catalog_base";

export type MotivoSemPreco =
  | "conta_sem_lista"
  | "lista_inativa"
  | "produto_fora_da_lista"
  | "produto_inativo"
  | "produto_inexistente"
  | "conta_inexistente";

export interface InsumoDaConta {
  /** `null` = conta sem lista (ou nenhuma conta informada): vai direto ao base. */
  price_list_id: string | null;
}

export interface InsumoDaLista {
  id: string;
  status: string; // CHECK do banco: active | inactive
  moeda: string;
}

export interface InsumoDoItem {
  preco_cents: number;
  moeda: string; // redundante por desenho: a lista governa (A4), conferido no resolver
}

export interface InsumoDoProduto {
  id: string;
  codigo: string;
  nome: string;
  preco_cents: number;
  moeda: string;
  ativo: boolean;
}

export type PrecoResolvido =
  | {
      status: "resolved";
      unit_price_cents: number;
      moeda: string;
      fonte: FonteDePreco;
      price_list_id: string | null;
      price_list_item_id: string | null;
      produto: { id: string; codigo: string; nome: string };
      quantidade: number;
    }
  | {
      status: "no_price";
      motivo: MotivoSemPreco;
      produto: { id: string; codigo: string; nome: string } | null;
      quantidade: number;
    };

export interface EntradaDaResolucao {
  organizationId: string;
  accountId: string | null;
  productId: string;
  quantidade: number;
  /** Linhas já lidas do banco (o IO em `consultar.ts` busca com filtro de org). */
  conta: InsumoDaConta | null;
  lista: InsumoDaLista | null;
  item: (InsumoDoItem & { id: string }) | null;
  produto: InsumoDoProduto | null;
}

/**
 * A decisão. Pura: os MESMOS insumos → a MESMA saída, sempre.
 */
export function resolverPreco(entrada: EntradaDaResolucao): PrecoResolvido {
  const { organizationId, accountId, productId, quantidade, conta, lista, item, produto } = entrada;

  const produtoSnapshot = produto
    ? { id: produto.id, codigo: produto.codigo, nome: produto.nome }
    : null;

  // ── 0. A2 é ABSOLUTO: produto inativo não tem preço por caminho nenhum ──
  // Nem o base, nem o da lista (uma lista ativa com item de produto desativado
  // nunca vira preço — o produto saiu de circulação).
  if (produto && !produto.ativo) {
    return {
      status: "no_price",
      motivo: "produto_inativo",
      produto: produtoSnapshot,
      quantidade,
    };
  }

  // ── 1. Preço de LISTA ────────────────────────────────────────────────────
  // A conta precisa existir (mesma org), apontar para uma lista, a lista tem
  // de estar ativa e o item tem de existir. Qualquer elo falho → cai ao base
  // (A1/A3) — nunca erro: lista é camada de SOBREPOSIÇÃO, não pré-requisito.
  if (conta && conta.price_list_id && lista && lista.id === conta.price_list_id) {
    if (lista.status === "active" && item && produto) {
      // Cinto e suspensório (A4): a moeda do ITEM é a da LISTA no banco de
      // verdade (item não tem moeda própria); se um dia divergirem, o preço
      // da lista NÃO é servido — falha fechada vale mais que moeda trocada.
      if (item.moeda === lista.moeda) {
        return {
          status: "resolved",
          unit_price_cents: item.preco_cents,
          moeda: lista.moeda,
          fonte: "price_list",
          price_list_id: lista.id,
          price_list_item_id: item.id,
          produto: produtoSnapshot!,
          quantidade,
        };
      }
    }
  }

  // ── 2. Preço BASE do catálogo ────────────────────────────────────────────
  if (!produto) {
    return {
      status: "no_price",
      motivo: conta === null && accountId !== null ? "conta_inexistente" : "produto_inexistente",
      produto: null,
      quantidade,
    };
  }
  return {
    status: "resolved",
    unit_price_cents: produto.preco_cents,
    moeda: produto.moeda,
    fonte: "catalog_base",
    price_list_id: null,
    price_list_item_id: null,
    produto: { id: produto.id, codigo: produto.codigo, nome: produto.nome },
    quantidade,
  };
}

/**
 * O CONTRATO DE SNAPSHOT para o Order Engine (Fase 4): o que congelar em
 * `order_items` na CONFIRMAÇÃO do pedido, para que pedido histórico nunca
 * mude quando o catálogo ou a lista mudarem. O resolver devolve exatamente
 * estes campos — o engine persiste, não recalcula.
 */
export interface InstantaneoDePreco {
  product_id: string;
  sku: string;
  nome: string;
  unit_price_cents: number;
  moeda: string;
  fonte: FonteDePreco;
  price_list_id: string | null;
  price_list_item_id: string | null;
  resolvido_em: string;
}

/** Extrai o snapshot de uma resolução bem-sucedida (chamado no momento da confirmação). */
export function capturarInstantaneo(r: Extract<PrecoResolvido, { status: "resolved" }>, agora: Date): InstantaneoDePreco {
  return {
    product_id: r.produto.id,
    sku: r.produto.codigo,
    nome: r.produto.nome,
    unit_price_cents: r.unit_price_cents,
    moeda: r.moeda,
    fonte: r.fonte,
    price_list_id: r.price_list_id,
    price_list_item_id: r.price_list_item_id,
    resolvido_em: agora.toISOString(),
  };
}
