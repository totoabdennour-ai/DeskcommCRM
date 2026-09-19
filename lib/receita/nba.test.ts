import { describe, expect, it } from "vitest";

import { nbaDoTipo, priorizar } from "./nba";

/**
 * A PRIORIDADE DA NBA É FUNÇÃO PURA E EXPLICÁVEL (doc 28 §4): sem score
 * opaco, sem LLM. Os testes travam a ordem (severidade → prazo → valor) e a
 * razão legível que acompanha cada escolha.
 */

const risco = (over: {
  risk_type: string;
  estimated_value_cents?: number | null;
  deadline_at?: string | null;
}) => ({
  risk_type: over.risk_type,
  estimated_value_cents: over.estimated_value_cents ?? null,
  deadline_at: over.deadline_at ?? null,
});

describe("nbaDoTipo — mapeamento determinístico tipo → ação", () => {
  it("cada tipo tem a ação prevista no doc 28", () => {
    expect(nbaDoTipo("abandoned_draft_order")?.action).toBe("request_confirmation");
    expect(nbaDoTipo("inquiry_without_response")?.action).toBe("follow_up_customer");
    expect(nbaDoTipo("no_price")?.action).toBe("clarify_product");
    expect(nbaDoTipo("stalled_opportunity")?.action).toBe("follow_up_customer");
    expect(nbaDoTipo("dormant_customer")?.action).toBe("reactivate_customer");
    expect(nbaDoTipo("unresolved_open_state")?.action).toBe("follow_up_customer");
  });

  it("tipo desconhecido → null (nenhuma ação inventada)", () => {
    expect(nbaDoTipo("tipo_que_nao_existe")).toBeNull();
  });

  it("razão é sempre legível (não vazia)", () => {
    for (const tipo of [
      "abandoned_draft_order",
      "inquiry_without_response",
      "no_price",
      "stalled_opportunity",
      "dormant_customer",
      "unresolved_open_state",
    ]) {
      expect(nbaDoTipo(tipo)?.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("priorizar — ordem explicável", () => {
  it("dinheiro comprometido (rascunho) vence cliente quente vence esfriando", () => {
    const ordenados = priorizar([
      risco({ risk_type: "dormant_customer" }),
      risco({ risk_type: "inquiry_without_response" }),
      risco({ risk_type: "abandoned_draft_order" }),
      risco({ risk_type: "stalled_opportunity" }),
    ]);
    expect(ordenados.map((r) => r.risk_type)).toEqual([
      "abandoned_draft_order",
      "inquiry_without_response",
      "stalled_opportunity",
      "dormant_customer",
    ]);
  });

  it("mesma severidade: deadline mais próxima primeiro", () => {
    const ordenados = priorizar([
      risco({ risk_type: "abandoned_draft_order", deadline_at: "2026-10-02T00:00:00Z" }),
      risco({ risk_type: "abandoned_draft_order", deadline_at: "2026-09-20T00:00:00Z" }),
    ]);
    expect(ordenados[0]!.deadline_at).toBe("2026-09-20T00:00:00Z");
  });

  it("sem deadline: maior valor estimado primeiro", () => {
    const ordenados = priorizar([
      risco({ risk_type: "abandoned_draft_order", estimated_value_cents: 100 }),
      risco({ risk_type: "abandoned_draft_order", estimated_value_cents: 9000 }),
    ]);
    expect(ordenados[0]!.estimated_value_cents).toBe(9000);
  });

  it("determinismo: mesma entrada → mesma saída, com razão em cada item", () => {
    const entrada = [
      risco({ risk_type: "no_price" }),
      risco({ risk_type: "dormant_customer", estimated_value_cents: 5000 }),
    ];
    expect(priorizar(entrada)).toEqual(priorizar([...entrada]));
    for (const item of priorizar(entrada)) {
      expect(item.nba.reason.length).toBeGreaterThan(10);
    }
  });

  it("tipo desconhecido é descartado (nunca vira ação inventada)", () => {
    expect(priorizar([risco({ risk_type: "tipo_fantasma" })])).toEqual([]);
  });
});
