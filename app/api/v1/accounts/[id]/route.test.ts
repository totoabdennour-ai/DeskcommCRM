import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONTA = "33333333-3333-4333-8333-333333333333";

const CONTO_ID = "55555555-5555-4555-8555-555555555555";
const PEDIDO = "66666666-6666-4666-8666-666666666666";

/**
 * O CONTRATO DO ACCOUNT 360 (Fase 7): a rota agrega só fontes
 * authoritative/derived e o agrupamento de moeda é FEITO NO SERVIDOR —
 * o campo `moeda: settings` da F6 não volta (era config rotulada de moeda).
 */
function supabaseFalso() {
  /**
   * O dublê é POR TABELA: cada chain devolve a tabela certa no await. O erro
   * que este desenho evita: métodos de chain retornando um `self` base que
   * resolve vazio — os dados da tabela sumiam silenciosamente do 360.
   */
  function chainDe(dados: unknown) {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (res: (r: { data: unknown; error: unknown }) => void) =>
        res({ data: dados, error: null }),
      maybeSingle: async () =>
        Array.isArray(dados) ? { data: dados[0] ?? null, error: null } : { data: dados, error: null },
    };
    return chain;
  }

  return {
    from: (tabela: string) => {
      if (tabela === "accounts") {
        return chainDe({
          id: CONTA,
          organization_id: ORG_ID,
          name: "Distribuidora Central",
          external_id: null,
          status: "active",
          settings: { qualquer: "config" },
          owner_user_id: null,
        });
      }
      if (tabela === "contacts") {
        return chainDe([
          { id: CONTO_ID, display_name: "João", phone_number: null, last_activity_at: null },
        ]);
      }
      if (tabela === "orders") {
        return chainDe([
          { id: PEDIDO, status: "confirmed", total_cents: 10000, currency: "BRL" },
          { id: "77777777-7777-4777-8777-777777777777", status: "confirmed", total_cents: 2500, currency: "BRL" },
          { id: "88888888-8888-4888-8888-888888888888", status: "confirmed", total_cents: 5000, currency: "MXN" },
        ]);
      }
      if (tabela === "order_items") return chainDe([]);
      if (tabela === "crm_leads") return chainDe([]);
      if (tabela === "conversations") return chainDe([]);
      if (tabela === "revenue_at_risk") return chainDe([]);
      if (tabela === "revenue_events") return chainDe([]);
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  } as never;
}

function requisicao(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue(supabaseFalso());
});

describe("GET /api/v1/accounts/:id — Account 360 (Fase 7)", () => {
  it("F7-FIX: não devolve mais 'moeda: settings' — devolve agrupamento por moeda", async () => {
    const { GET } = await import("./route");

    const resposta = await GET(requisicao(`http://localhost/api/v1/accounts/${CONTA}`), {
      params: Promise.resolve({ id: CONTA }),
    } as never);
    const corpo = (await resposta.json()) as {
      data: { receita: { por_moeda: Array<{ moeda: string; total_cents: number }>; moeda?: unknown } };
    };

    expect(resposta.status).toBe(200);
    expect(corpo.data.receita.por_moeda).toEqual([
      { moeda: "BRL", total_cents: 12500, pedidos: 2 },
      { moeda: "MXN", total_cents: 5000, pedidos: 1 },
    ]);
    expect(corpo.data.receita).not.toHaveProperty("moeda");
  });

  it("inclui conversas recentes e seções do contrato", async () => {
    const { GET } = await import("./route");

    const resposta = await GET(requisicao(`http://localhost/api/v1/accounts/${CONTA}`), {
      params: Promise.resolve({ id: CONTA }),
    } as never);
    const corpo = (await resposta.json()) as {
      data: { conversas: unknown[]; contatos: unknown[]; oportunidades: unknown[]; pedidos: unknown[]; revenue_at_risk: unknown; eventos_receita: unknown[]; proximas_acoes: unknown[] };
    };

    expect(Array.isArray(corpo.data.conversas)).toBe(true);
    expect(Array.isArray(corpo.data.contatos)).toBe(true);
    expect(Array.isArray(corpo.data.oportunidades)).toBe(true);
    expect(Array.isArray(corpo.data.pedidos)).toBe(true);
    expect(corpo.data.revenue_at_risk).toBeDefined();
    expect(Array.isArray(corpo.data.eventos_receita)).toBe(true);
    expect(Array.isArray(corpo.data.proximas_acoes)).toBe(true);
  });

  it("org filter vai da sessão (conta de outra org → 404)", async () => {
    const semConta = {
      from: (tabela: string) => {
        void tabela;
        const self: Record<string, unknown> = {
          select: () => self,
          eq: () => self,
          in: () => self,
          order: () => self,
          limit: () => self,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (res: (r: { data: unknown; error: unknown }) => void) => res({ data: [], error: null }),
        };
        return self;
      },
    } as never;
    vi.mocked(createClient).mockResolvedValue(semConta);
    const { GET } = await import("./route");

    const resposta = await GET(requisicao(`http://localhost/api/v1/accounts/${CONTA}`), {
      params: Promise.resolve({ id: CONTA }),
    } as never);

    expect(resposta.status).toBe(404);
  });
});
