import { describe, expect, it } from "vitest";

import { capturarInstantaneo, resolverPreco, type EntradaDaResolucao } from "./resolver";

/**
 * O RESOLVER É A AUTORIDADE DE PREÇO — e por isso os testes travam a DECISÃO,
 * não a implementação: precedência, inativos, ausência, moeda trocada e
 * determinismo. O que a IA provara não está aqui: IA nem chega a este módulo
 * (a tool de consulta da F5 chama `consultarPreco`, que chama ESTA função).
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTA = "33333333-3333-4333-8333-333333333333";
const LISTA = "44444444-4444-4444-8444-444444444444";
const ITEM = "55555555-5555-4555-8555-555555555555";
const PRODUTO = "66666666-6666-4666-8666-666666666666";

const PRODUTO_ATIVO: EntradaDaResolucao["produto"] = {
  id: PRODUTO,
  codigo: "IP15-256",
  nome: "iPhone 15 256GB",
  preco_cents: 549900,
  moeda: "BRL",
  ativo: true,
};

function entrada(over: Partial<EntradaDaResolucao> = {}): EntradaDaResolucao {
  return {
    organizationId: ORG,
    accountId: CONTA,
    productId: PRODUTO,
    quantidade: 3,
    conta: { price_list_id: null },
    lista: null,
    item: null,
    produto: PRODUTO_ATIVO,
    ...over,
  };
}

describe("resolverPreco — precedência", () => {
  it("conta SEM lista → preço BASE do catálogo", () => {
    const r = resolverPreco(entrada());
    expect(r).toMatchObject({
      status: "resolved",
      unit_price_cents: 549900,
      moeda: "BRL",
      fonte: "catalog_base",
      price_list_id: null,
    });
  });

  it("conta com lista ATIVA + item → preço da LISTA vence o base", () => {
    const r = resolverPreco(
      entrada({
        conta: { price_list_id: LISTA },
        lista: { id: LISTA, status: "active", moeda: "BRL" },
        item: { id: ITEM, preco_cents: 499900, moeda: "BRL" },
      }),
    );
    expect(r).toMatchObject({
      status: "resolved",
      unit_price_cents: 499900,
      fonte: "price_list",
      price_list_id: LISTA,
      price_list_item_id: ITEM,
    });
  });

  it("lista inativa é IGNORADA — cai ao base (A3)", () => {
    const r = resolverPreco(
      entrada({
        conta: { price_list_id: LISTA },
        lista: { id: LISTA, status: "inactive", moeda: "BRL" },
        item: { id: ITEM, preco_cents: 499900, moeda: "BRL" },
      }),
    );
    expect(r).toMatchObject({ status: "resolved", unit_price_cents: 549900, fonte: "catalog_base" });
  });

  it("produto FORA da lista herda o base (A1)", () => {
    const r = resolverPreco(
      entrada({
        conta: { price_list_id: LISTA },
        lista: { id: LISTA, status: "active", moeda: "BRL" },
        item: null,
      }),
    );
    expect(r).toMatchObject({ status: "resolved", unit_price_cents: 549900, fonte: "catalog_base" });
  });

  it("lista divergente da conta (id diferente) não é seguida — defesa em profundidade", () => {
    // O IO só busca a lista do price_list_id da conta; se o id vier trocado,
    // o resolver NÃO segue — cai ao base em vez de usar preço de outra lista.
    const r = resolverPreco(
      entrada({
        conta: { price_list_id: LISTA },
        lista: { id: "77777777-7777-4777-8777-777777777777", status: "active", moeda: "BRL" },
        item: { id: ITEM, preco_cents: 1, moeda: "BRL" },
      }),
    );
    expect(r).toMatchObject({ status: "resolved", unit_price_cents: 549900, fonte: "catalog_base" });
  });
});

describe("resolverPreco — sem preço, com motivo", () => {
  it("produto inexistente → no_price produto_inexistente", () => {
    const r = resolverPreco(entrada({ produto: null }));
    expect(r).toMatchObject({ status: "no_price", motivo: "produto_inexistente" });
  });

  it("produto inativo → no_price produto_inativo, MESMO com item de lista", () => {
    const r = resolverPreco(
      entrada({
        conta: { price_list_id: LISTA },
        lista: { id: LISTA, status: "active", moeda: "BRL" },
        item: { id: ITEM, preco_cents: 499900, moeda: "BRL" },
        produto: { ...PRODUTO_ATIVO, ativo: false },
      }),
    );
    expect(r).toMatchObject({ status: "no_price", motivo: "produto_inativo" });
  });
});

describe("resolverPreco — moeda e determinismo", () => {
  it("moeda do item ≠ moeda da lista → falha FECHADA: cai ao base, nunca serve moeda trocada (A4)", () => {
    const r = resolverPreco(
      entrada({
        conta: { price_list_id: LISTA },
        lista: { id: LISTA, status: "active", moeda: "USD" },
        item: { id: ITEM, preco_cents: 9900, moeda: "BRL" },
      }),
    );
    expect(r).toMatchObject({ status: "resolved", unit_price_cents: 549900, fonte: "catalog_base" });
  });

  it("lista em moeda própria e consistente serve a moeda DA LISTA", () => {
    const r = resolverPreco(
      entrada({
        conta: { price_list_id: LISTA },
        lista: { id: LISTA, status: "active", moeda: "USD" },
        item: { id: ITEM, preco_cents: 9900, moeda: "USD" },
        produto: { ...PRODUTO_ATIVO, moeda: "USD" },
      }),
    );
    expect(r).toMatchObject({ status: "resolved", moeda: "USD", unit_price_cents: 9900 });
  });

  it("determinismo: os mesmos insumos devolvem a mesma saída, sempre", () => {
    const e = entrada({
      conta: { price_list_id: LISTA },
      lista: { id: LISTA, status: "active", moeda: "BRL" },
      item: { id: ITEM, preco_cents: 499900, moeda: "BRL" },
    });
    expect(resolverPreco(e)).toEqual(resolverPreco(e));
  });

  it("quantidade viaja na saída mas NÃO muda o unitário (A5)", () => {
    const um = resolverPreco(entrada({ quantidade: 1 }));
    const cem = resolverPreco(entrada({ quantidade: 100 }));
    if (um.status !== "resolved" || cem.status !== "resolved") throw new Error("esperava resolved");
    expect(um.unit_price_cents).toBe(cem.unit_price_cents);
    expect(cem.quantidade).toBe(100);
  });
});

describe("capturarInstantaneo — o contrato de snapshot do Order Engine", () => {
  it("congela tudo que o order_items precisa, com o instante da confirmação", () => {
    const r = resolverPreco(
      entrada({
        conta: { price_list_id: LISTA },
        lista: { id: LISTA, status: "active", moeda: "BRL" },
        item: { id: ITEM, preco_cents: 499900, moeda: "BRL" },
      }),
    );
    if (r.status !== "resolved") throw new Error("esperava resolved");
    const agora = new Date("2026-09-16T12:00:00Z");
    const snap = capturarInstantaneo(r, agora);
    expect(snap).toEqual({
      product_id: PRODUTO,
      sku: "IP15-256",
      nome: "iPhone 15 256GB",
      unit_price_cents: 499900,
      moeda: "BRL",
      fonte: "price_list",
      price_list_id: LISTA,
      price_list_item_id: ITEM,
      resolvido_em: "2026-09-16T12:00:00.000Z",
    });
  });
});
