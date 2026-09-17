import { describe, expect, it } from "vitest";

import { COLUNAS_DA_LISTA, STATUS_DA_LISTA, itemUpsertSchema, listaCreateSchema, listaPatchSchema } from "./precos";

/**
 * Contrato de precificação (0240, Fase 3). O CHECK do banco é a autoridade do
 * vocabulário de status; o par completo vive no invariante de vocabulário.
 */
describe("listaCreateSchema", () => {
  it("aceita o mínimo: só o nome (moeda default é a da ORG, decidida na rota)", () => {
    const parsed = listaCreateSchema.parse({ nome: "Conta Central 2026" });
    expect(parsed.nome).toBe("Conta Central 2026");
    expect(parsed.status).toBe("active");
    // A moeda NÃO vem do corpo: o schema nem declara (moeda da org decide).
    expect("moeda" in parsed).toBe(false);
  });

  it("recusa nome vazio e status fora do vocabulário do banco", () => {
    expect(listaCreateSchema.safeParse({ nome: "" }).success).toBe(false);
    expect(listaCreateSchema.safeParse({ nome: "X", status: "archived" }).success).toBe(false);
  });

  it("moeda NÃO é aceita do corpo — a da organização decide na rota", () => {
    // Doutrina do moedaDaOrganizacao: o corpo nunca decide unidade. O schema
    // nem declara o campo, então o Zod descarta antes de a rota ler.
    const parsed = listaCreateSchema.parse({ nome: "X", moeda: "USD" });
    expect("moeda" in parsed).toBe(false);
  });
});

describe("listaPatchSchema", () => {
  it("aceita patch parcial e recusa status estranho", () => {
    expect(listaPatchSchema.parse({ status: "inactive" })).toEqual({ status: "inactive" });
    expect(listaPatchSchema.safeParse({ status: "pausada" }).success).toBe(false);
  });
});

describe("itemUpsertSchema", () => {
  it("preço em centavos inteiros >= 0; recusa quebrado e negativo", () => {
    expect(itemUpsertSchema.safeParse({ product_id: "11111111-1111-4111-8111-111111111111", preco_cents: 499900 }).success).toBe(true);
    expect(itemUpsertSchema.safeParse({ product_id: "11111111-1111-4111-8111-111111111111", preco_cents: 4999.9 }).success).toBe(false);
    expect(itemUpsertSchema.safeParse({ product_id: "11111111-1111-4111-8111-111111111111", preco_cents: -1 }).success).toBe(false);
  });

  it("recusa product_id que não é uuid", () => {
    expect(itemUpsertSchema.safeParse({ product_id: "ip15", preco_cents: 1 }).success).toBe(false);
  });
});

describe("STATUS_DA_LISTA / COLUNAS_DA_LISTA", () => {
  it("vocabulário bate com o CHECK da 0240", () => {
    expect(STATUS_DA_LISTA).toEqual(["active", "inactive"]);
  });

  it("colunas do SELECT incluem pk e tenant", () => {
    expect(COLUNAS_DA_LISTA).toContain("id");
    expect(COLUNAS_DA_LISTA).toContain("organization_id");
    expect(COLUNAS_DA_LISTA).toContain("moeda");
  });
});
