import { describe, expect, it, vi, beforeEach } from "vitest";

import type { McpContext } from "../types";

/**
 * AS TOOLS DE PEDIDO DO AGENTE B2B (Fase 5) — o agente é INTERFACE, não fonte
 * de verdade. O que estes testes travam no handler:
 *  - contexto: resolve contato → conta → rascunho aberto, org-scoped; sem
 *    conta devolve instrução de NÃO inventar;
 *  - update: só draft, linhas completas, recusa modelada com flag de escalação
 *    determinística (classificarRecusaDePedido);
 *  - nenhuma das duas confirma, calcula preço ou aceita preço do modelo.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "66666666-6666-4666-8666-666666666666";
const CONTA = "33333333-3333-4333-8333-333333333333";
const PEDIDO = "88888888-8888-4888-8888-888888888888";
const PRODUTO = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/orders/engine", () => ({
  criarRascunho: vi.fn(),
  editarRascunho: vi.fn(),
}));

const { crmGetOrderContext, crmUpdateOrderDraft } = await import("./comercio");
const { editarRascunho } = await import("@/lib/orders/engine");

type Tabela = string;
function ctxCom(tabelas: Partial<Record<Tabela, () => unknown>>): McpContext {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "ai_agent", id: "run-1", agent_id: "agent-1" },
    apiTokenId: "44444444-4444-4444-8444-444444444444",
    requestId: "55555555-5555-4555-8555-555555555555",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: {
      from: (tabela: string) => {
        const fabrica = tabelas[tabela];
        if (!fabrica) throw new Error(`tabela não mockada: ${tabela}`);
        return fabrica();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  } as McpContext;
}

const contatoComConta = () => ({
  select: () => ({
    eq: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { id: CONTATO, account_id: CONTA, display_name: "João" }, error: null }),
      }),
    }),
  }),
});
const contaRow = () => ({
  select: () => ({
    eq: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: { id: CONTA, name: "Distribuidora Central", status: "active", price_list_id: null, settings: {} },
          error: null,
        }),
      }),
    }),
  }),
});
const semLinhas = () => ({
  select: () => ({
    eq: () => ({
      eq: () => ({
        order: async () => ({ data: [], error: null }),
      }),
    }),
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("crm_get_order_context — a conta resolve pelo contato (0239)", () => {
  it("contato com conta devolve a conta e a instrução de operação", async () => {
    const ctx = ctxCom({
      contacts: contatoComConta,
      accounts: contaRow,
      orders: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });

    const r = await crmGetOrderContext.handler(
      { contact_id: CONTATO },
      ctx,
    );

    expect((r as { encontrado: boolean }).encontrado).toBe(true);
    expect((r as { conta: { id: string } | null }).conta?.id).toBe(CONTA);
    expect((r as { rascunho: unknown }).rascunho).toBeNull();
  });

  it("contato SEM conta devolve conta=null + instrução de NÃO inventar", async () => {
    const ctx = ctxCom({
      contacts: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: CONTATO, account_id: null, display_name: "Avulso" }, error: null }),
            }),
          }),
        }),
      }),
    });

    const r = (await crmGetOrderContext.handler({ contact_id: CONTATO }, ctx)) as {
      conta: unknown;
      instrucao: string;
    };

    expect(r.conta).toBeNull();
    expect(r.instrucao).toMatch(/NÃO invente conta/);
  });

  it("contato de OUTRA org é inexistente (org-scoped — nunca vaza)", async () => {
    const ctx = ctxCom({
      contacts: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
    });

    const r = (await crmGetOrderContext.handler({ contact_id: CONTATO }, ctx)) as {
      encontrado: boolean;
      motivo: string;
    };

    expect(r.encontrado).toBe(false);
    expect(r.motivo).toBe("contato_inexistente");
  });

  it("rascunho aberto vem com as linhas e a instrução de ATUALIZAR, não criar outro", async () => {
    const ctx = ctxCom({
      contacts: contatoComConta,
      accounts: contaRow,
      orders: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: { id: PEDIDO, external_id: "PED-2026-aa", status: "draft", total_cents: 900, currency: "BRL" },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
      order_items: semLinhas,
    });

    const r = (await crmGetOrderContext.handler({ contact_id: CONTATO }, ctx)) as {
      rascunho: { id: string } | null;
      instrucao: string;
    };

    expect(r.rascunho?.id).toBe(PEDIDO);
    expect(r.instrucao).toMatch(/crm_update_order_draft/);
  });
});

describe("crm_update_order_draft — só draft, recusa modelada, sem preço do modelo", () => {
  const LINHAS = [{ product_id: PRODUTO, quantity: 5 }];

  it("rascunho da org + edita via engine e devolve total", async () => {
    vi.mocked(editarRascunho).mockResolvedValue({ ok: true, total_cents: 4500 });
    const ctx = ctxCom({
      orders: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: PEDIDO, status: "draft", account_id: CONTA },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const r = (await crmUpdateOrderDraft.handler(
      { order_id: PEDIDO, items: LINHAS },
      ctx,
    )) as { pedido_atualizado: boolean; total_cents: number };

    expect(r.pedido_atualizado).toBe(true);
    expect(r.total_cents).toBe(4500);
    expect(editarRascunho).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        orderId: PEDIDO,
        accountId: CONTA,
        linhas: LINHAS,
        actorKind: "ai",
      }),
    );
  });

  it("pedido CONFIRMADO recusa com instrução de NÃO prometer alteração", async () => {
    const ctx = ctxCom({
      orders: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: PEDIDO, status: "confirmed", account_id: CONTA },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const r = (await crmUpdateOrderDraft.handler(
      { order_id: PEDIDO, items: LINHAS },
      ctx,
    )) as { pedido_atualizado: boolean; motivo: string; instrucao: string };

    expect(r.pedido_atualizado).toBe(false);
    expect(r.motivo).toBe("nao_e_rascunho");
    expect(r.instrucao).toMatch(/NÃO prometa alteração/);
  });

  it("recusa de preço determinística: moeda_mista carrega escalar_para_humano=true", async () => {
    vi.mocked(editarRascunho).mockResolvedValue({
      ok: false,
      motivo: "moeda_mista",
      produto: { codigo: "IP15", nome: "iPhone 15" },
    });
    const ctx = ctxCom({
      orders: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: PEDIDO, status: "draft", account_id: CONTA },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const r = (await crmUpdateOrderDraft.handler(
      { order_id: PEDIDO, items: LINHAS },
      ctx,
    )) as { pedido_atualizado: boolean; escalar_para_humano: boolean };

    expect(r.pedido_atualizado).toBe(false);
    expect(r.escalar_para_humano).toBe(true);
  });

  it("recusa recuperável (produto_inativo) NÃO escala — o agente explica e segue", async () => {
    vi.mocked(editarRascunho).mockResolvedValue({
      ok: false,
      motivo: "produto_inativo",
      produto: { codigo: "IP15", nome: "iPhone 15" },
    });
    const ctx = ctxCom({
      orders: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: PEDIDO, status: "draft", account_id: CONTA },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const r = (await crmUpdateOrderDraft.handler(
      { order_id: PEDIDO, items: LINHAS },
      ctx,
    )) as { pedido_atualizado: boolean; escalar_para_humano?: boolean };

    expect(r.pedido_atualizado).toBe(false);
    expect(r.escalar_para_humano).toBe(false);
  });

  it("pedido sem conta → recusa com escalação (identidade não se resolve na conversa)", async () => {
    const ctx = ctxCom({
      orders: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: PEDIDO, status: "draft", account_id: null },
                error: null,
              }),
            }),
          }),
        }),
      }),
    });

    const r = (await crmUpdateOrderDraft.handler(
      { order_id: PEDIDO, items: LINHAS },
      ctx,
    )) as { pedido_atualizado: boolean; escalar_para_humano: boolean };

    expect(r.pedido_atualizado).toBe(false);
    expect(r.escalar_para_humano).toBe(true);
  });
});
