import { describe, expect, it } from "vitest";

import { COLUNAS_DA_CONTA, CONTAS_STATUS, contaCreateSchema, contaPatchSchema } from "./contas";

/**
 * Contrato de contas B2B (Fase 2). O CHECK do banco é a autoridade do
 * vocabulário de status — este teste trava que o Zod e o banco dizem o mesmo
 * (o par completo vive em tests/invariants/vocabulario-banco-x-typescript).
 */
describe("contaCreateSchema", () => {
  it("aceita o mínimo: só o nome", () => {
    const parsed = contaCreateSchema.parse({ name: "Distribuidora Central" });
    expect(parsed.name).toBe("Distribuidora Central");
    expect(parsed.status).toBe("active");
    expect(parsed.external_id ?? null).toBeNull();
  });

  it("recusa nome vazio ou só espaço", () => {
    expect(contaCreateSchema.safeParse({ name: "" }).success).toBe(false);
    expect(contaCreateSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("recusa status fora do vocabulário do banco", () => {
    expect(contaCreateSchema.safeParse({ name: "X", status: "suspended" }).success).toBe(false);
  });

  it("recusa owner_user_id que não é uuid", () => {
    expect(contaCreateSchema.safeParse({ name: "X", owner_user_id: "nao-uuid" }).success).toBe(false);
  });

  it("external_id aceita null e string", () => {
    expect(contaCreateSchema.safeParse({ name: "X", external_id: null }).success).toBe(true);
    expect(contaCreateSchema.safeParse({ name: "X", external_id: "ERP-42" }).success).toBe(true);
    expect(contaCreateSchema.safeParse({ name: "X", external_id: "" }).success).toBe(false);
  });

  it("recusa settings que não são objeto ou estouram 16kB", () => {
    expect(contaCreateSchema.safeParse({ name: "X", settings: "texto" }).success).toBe(false);
    expect(
      contaCreateSchema.safeParse({ name: "X", settings: { grande: "x".repeat(17_000) } }).success,
    ).toBe(false);
    expect(contaCreateSchema.safeParse({ name: "X", settings: { moeda: "BRL" } }).success).toBe(true);
  });
});

describe("contaPatchSchema", () => {
  it("aceita patch parcial (só status)", () => {
    expect(contaPatchSchema.parse({ status: "archived" })).toEqual({ status: "archived" });
  });

  it("aceita patch vazio (não muda nada) e recusa unknown shape no campo conhecido", () => {
    expect(contaPatchSchema.safeParse({}).success).toBe(true);
    expect(contaPatchSchema.safeParse({ status: "cancelada" }).success).toBe(false);
  });
});

describe("CONTAS_STATUS / COLUNAS_DA_CONTA", () => {
  it("vocabulário bate com o CHECK da 0239", () => {
    expect(CONTAS_STATUS).toEqual(["active", "inactive", "archived"]);
  });

  it("colunas do SELECT incluem a PK e o tenant", () => {
    expect(COLUNAS_DA_CONTA).toContain("id");
    expect(COLUNAS_DA_CONTA).toContain("organization_id");
    expect(COLUNAS_DA_CONTA).toContain("owner_user_id");
  });
});
