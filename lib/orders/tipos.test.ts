import { describe, expect, it } from "vitest";

import {
  classificarRecusaDePedido,
  KINDS_DO_PEDIDO,
  numeroExternoNativo,
  totalDasLinhas,
  transicaoValida,
} from "./tipos";

/**
 * A máquina de estados do pedido (Fase 4) — PURA: transição, total e numeração.
 * O banco é a autoridade (RPCs do 0241); estes testes travam a MESMA decisão
 * do lado TypeScript, que é o que as rotas consultam antes de chamar o RPC.
 */
describe("transicaoValida", () => {
  it("draft → confirmed e draft/confirmed → cancelled existem", () => {
    expect(transicaoValida("draft", "confirmed")).toBeNull();
    expect(transicaoValida("draft", "cancelled")).toBeNull();
    expect(transicaoValida("confirmed", "cancelled")).toBeNull();
  });

  it("nada sai de cancelled; confirmado não volta a draft; estados espelho seguem proibidos por aqui", () => {
    expect(transicaoValida("cancelled", "draft")).not.toBeNull();
    expect(transicaoValida("confirmed", "draft")).not.toBeNull();
    expect(transicaoValida("draft", "pending")).not.toBeNull();
    expect(transicaoValida("fulfilled", "closed")).not.toBeNull();
  });

  it("estado idêntico é recusado com motivo próprio", () => {
    expect(transicaoValida("draft", "draft")).toBe("estado idêntico");
  });
});

describe("totalDasLinhas — DIRC: calculado, nunca armazenado como verdade", () => {
  it("soma unitário × quantidade de todas as linhas", () => {
    expect(
      totalDasLinhas([
        { unit_price_cents: 499900, quantity: 2 },
        { unit_price_cents: 1000, quantity: 3 },
      ]),
    ).toBe(499900 * 2 + 1000 * 3);
  });

  it("lista vazia soma zero (e o banco recusa pedido sem itens)", () => {
    expect(totalDasLinhas([])).toBe(0);
  });
});

describe("numeroExternoNativo — B2: legível, sem corrida", () => {
  it("formato PED-<ano>-<12 hex>", () => {
    const n = numeroExternoNativo(new Date("2026-09-17T12:00:00Z"), "a1b2c3d4-e5f6-4789-8abc-def012345678");
    expect(n).toMatch(/^PED-2026-[0-9a-f]{12}$/);
  });

  it("uuid diferente → número diferente (unicidade por construção)", () => {
    const a = numeroExternoNativo(new Date(), "11111111-1111-4111-8111-111111111111");
    const b = numeroExternoNativo(new Date(), "22222222-2222-4222-8222-222222222222");
    expect(a).not.toBe(b);
  });
});

describe("vocabulário", () => {
  it("kinds batem com o CHECK da 0241", () => {
    expect(KINDS_DO_PEDIDO).toEqual(["created", "edited", "confirmed", "cancelled"]);
  });
});

describe("classificarRecusaDePedido — o gatilho determinístico de escalação (Fase 5)", () => {
  it("conta_inexistente e moeda_mista ESCALAM (identidade/preço não se resolvem na conversa)", () => {
    expect(classificarRecusaDePedido("conta_inexistente").escalar_para_humano).toBe(true);
    expect(classificarRecusaDePedido("moeda_mista").escalar_para_humano).toBe(true);
  });

  it("produto inexistente/inativo e fora da lista NÃO escalam — o agente explica e segue", () => {
    expect(classificarRecusaDePedido("produto_inexistente").escalar_para_humano).toBe(false);
    expect(classificarRecusaDePedido("produto_inativo").escalar_para_humano).toBe(false);
    expect(classificarRecusaDePedido("produto_fora_da_lista").escalar_para_humano).toBe(false);
  });
});
