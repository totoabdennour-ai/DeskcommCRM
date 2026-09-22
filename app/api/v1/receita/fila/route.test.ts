import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONTA = "33333333-3333-4333-8333-333333333333";

let riscosRows: Array<Record<string, unknown>>;
let contasRows: Array<Record<string, unknown>>;

function supabaseFalso() {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    order: () => self,
    limit: () => self,
    then: (res: (r: { data: unknown; error: unknown }) => void) => res({ data: riscosRows, error: null }),
  };
  return {
    from: (tabela: string) => {
      if (tabela === "revenue_at_risk") return self;
      if (tabela === "accounts") {
        const acc: Record<string, unknown> = {
          select: () => acc,
          eq: () => acc,
          in: () => acc,
          then: (res: (r: { data: unknown; error: unknown }) => void) => res({ data: contasRows, error: null }),
        };
        return acc;
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  } as never;
}

function requisicao(): NextRequest {
  return new NextRequest("http://localhost/api/v1/receita/fila", { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  riscosRows = [];
  contasRows = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue(supabaseFalso());
});

describe("GET /api/v1/receita/fila — prioridade determinística do servidor", () => {
  it("ordena pela NBA pura: rascunho abandonado vence dormente (severidade)", async () => {
    riscosRows = [
      { id: "r-dorm", risk_type: "dormant_customer", source_kind: "account", source_id: CONTA, account_id: CONTA, order_id: null, trigger_detail: "dormente", estimated_value_cents: 9000, currency: "BRL", deadline_at: null, nba_action: "reactivate_customer", nba_reason: "win-back", detected_at: "2026-01-01" },
      { id: "r-rasc", risk_type: "abandoned_draft_order", source_kind: "order", source_id: "77777777-7777-4777-8777-777777777777", account_id: CONTA, order_id: "77777777-7777-4777-8777-777777777777", trigger_detail: "rascunho 30h", estimated_value_cents: 1000, currency: "BRL", deadline_at: null, nba_action: "request_confirmation", nba_reason: "retomar", detected_at: "2026-01-02" },
    ];
    contasRows = [{ id: CONTA, name: "Distribuidora Central" }];

    const { GET } = await import("./route");
    const resposta = await GET(requisicao());
    const corpo = (await resposta.json()) as { data: Array<{ id: string; account_name: string | null }> };

    expect(resposta.status).toBe(200);
    expect(corpo.data[0]!.id).toBe("r-rasc");
    expect(corpo.data[0]!.account_name).toBe("Distribuidora Central");
  });

  it("mesmo risco, segundo lugar quando o outro tem valor maior (critério de valor)", async () => {
    riscosRows = [
      { id: "r-a", risk_type: "inquiry_without_response", source_kind: "conversation", source_id: "88888888-8888-4888-8888-888888888888", account_id: CONTA, order_id: null, trigger_detail: "sem resposta", estimated_value_cents: 100, currency: "BRL", deadline_at: "2026-09-20", nba_action: "follow_up_customer", nba_reason: "r1", detected_at: "2026-01-01" },
      { id: "r-b", risk_type: "inquiry_without_response", source_kind: "conversation", source_id: "99999999-9999-4999-8999-999999999999", account_id: CONTA, order_id: null, trigger_detail: "sem resposta", estimated_value_cents: 9900, currency: "BRL", deadline_at: "2026-09-20", nba_action: "follow_up_customer", nba_reason: "r2", detected_at: "2026-01-01" },
    ];

    const { GET } = await import("./route");
    const resposta = await GET(requisicao());
    const corpo = (await resposta.json()) as { data: Array<{ id: string }> };

    expect(corpo.data[0]!.id).toBe("r-b");
  });
});
