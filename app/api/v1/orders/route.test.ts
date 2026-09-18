import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { criarRascunho } from "@/lib/orders/engine";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
// O RESOLVER é a autoridade de preço — o mock devolve o que um resolver real
// devolveria, e as asserções provam que a ROTA nunca aceita preço do corpo.
vi.mock("@/lib/pricing/consultar", () => ({ consultarPreco: vi.fn() }));
vi.mock("@/lib/orders/engine", () => ({ criarRascunho: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONTA = "33333333-3333-4333-8333-333333333333";
const PRODUTO = "66666666-6666-4666-8666-666666666666";

const PEDIDO = {
  account_id: CONTA,
  items: [{ product_id: PRODUTO, quantity: 2 }],
};

let respostaDaIdempotencia: {
  status_code: number;
  response_body: unknown;
  request_hash: string;
} | null;
let upsertDaIdempotencia: Record<string, unknown>[] = [];

function supabaseFalso() {
  return {
    from: (tabela: string) => {
      if (tabela !== "idempotency_keys") {
        throw new Error(`tabela inesperada no dublê: ${tabela}`);
      }
      const self: Record<string, unknown> = {
        select: () => self,
        eq: () => self,
        gt: () => self,
        upsert: (linha: Record<string, unknown>) => {
          upsertDaIdempotencia.push(linha);
          return { error: null };
        },
        maybeSingle: async () => ({ data: respostaDaIdempotencia, error: null }),
      };
      return self;
    },
  } as never;
}

function requisicao(corpo: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/v1/orders", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  respostaDaIdempotencia = null;
  upsertDaIdempotencia = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue(supabaseFalso());
  vi.mocked(criarRascunho).mockResolvedValue({
    ok: true,
    pedido: {
      replay: false,
      order_id: "88888888-8888-4888-8888-888888888888",
      external_id: "PED-2026-abc123def456",
      status: "draft",
      total_cents: 999800,
      linhas: [
      {
        product_id: PRODUTO,
        sku: "IP15",
        nome: "iPhone 15",
        unit_price_cents: 499900,
        moeda: "BRL",
        fonte: "catalog_base",
        price_list_id: null,
        price_list_item_id: null,
        resolvido_em: new Date().toISOString(),
        quantity: 2,
      },
    ],
    },
  });
});

describe("POST /api/v1/orders — o preço NUNCA vem do corpo", () => {
  it("corpo com unit_price_cents é descartado pelo schema — só produto e quantidade", async () => {
    const { POST } = await import("./route");

    const resposta = await POST(
      requisicao({ ...PEDIDO, items: [{ ...PEDIDO.items[0], unit_price_cents: 1 }] }),
    );

    expect(resposta.status).toBe(201);
    expect(criarRascunho).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG_ID,
        accountId: CONTA,
        linhas: [{ product_id: PRODUTO, quantity: 2 }],
      }),
    );
  });

  it("linha sem preço (no_price) recusa o pedido INTEIRO com o motivo", async () => {
    vi.mocked(criarRascunho).mockResolvedValue({
      ok: false,
      motivo: "produto_inativo",
      produto: { codigo: "IP15", nome: "iPhone 15" },
    });
    const { POST } = await import("./route");

    const resposta = await POST(requisicao(PEDIDO));
    const corpo = (await resposta.json()) as { error: { details: { motivo: string } } };

    expect(resposta.status).toBe(422);
    expect(corpo.error.details.motivo).toBe("produto_inativo");
  });

  it("org SEMPRE da sessão — nunca do corpo", async () => {
    const { POST } = await import("./route");

    await POST(requisicao({ ...PEDIDO, organization_id: "99999999-9999-4999-8999-999999999999" }));

    expect(criarRascunho).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG_ID }),
    );
  });
});

describe("POST /api/v1/orders — Idempotency-Key TRANSACIONAL (F4.1)", () => {
  const hashDe = (corpo: unknown): string =>
    createHash("sha256").update(JSON.stringify(corpo)).digest("hex");

  it("a chave e o hash VIAJAM para o engine (a RPC consome na transação)", async () => {
    const { POST } = await import("./route");

    await POST(requisicao(PEDIDO, { "Idempotency-Key": "chave-1" }));

    expect(criarRascunho).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: "chave-1",
        requestHash: hashDe(PEDIDO),
      }),
    );
  });

  it("mesma chave + mesmo corpo → 201 com replay=true e SEM audit de efeito novo", async () => {
    vi.mocked(criarRascunho).mockResolvedValue({
      ok: true,
      pedido: {
        replay: true,
        order_id: "88888888-8888-4888-8888-888888888888",
        external_id: "PED-2026-abc123def456",
        status: "draft",
        total_cents: 999800,
        linhas: [],
      },
    });
    const { audit } = await import("@/lib/audit");
    const { POST } = await import("./route");

    const resposta = await POST(requisicao(PEDIDO, { "Idempotency-Key": "chave-1" }));
    const corpo = (await resposta.json()) as { data: { replay: boolean; order_id: string } };

    expect(resposta.status).toBe(201);
    expect(corpo.data.replay).toBe(true);
    expect(corpo.data.order_id).toBe("88888888-8888-4888-8888-888888888888");
    expect(audit).not.toHaveBeenCalled();
  });

  it("mesma chave + corpo DIFERENTE → 409 determinístico (a RPC levanta conflito)", async () => {
    vi.mocked(criarRascunho).mockRejectedValue(
      new Error("fn_criar_pedido: idempotency_conflicting_body"),
    );
    const { POST } = await import("./route");

    const resposta = await POST(requisicao(PEDIDO, { "Idempotency-Key": "chave-1" }));

    expect(resposta.status).toBe(409);
  });

  it("replay NÃO linhas frescas — o resultado gravado é a verdade da re-entrega", async () => {
    vi.mocked(criarRascunho).mockResolvedValue({
      ok: true,
      pedido: {
        replay: true,
        order_id: "88888888-8888-4888-8888-888888888888",
        external_id: "PED-2026-abc123def456",
        status: "draft",
        total_cents: 999800,
        linhas: [],
      },
    });
    const { POST } = await import("./route");

    const resposta = await POST(requisicao(PEDIDO, { "Idempotency-Key": "chave-1" }));
    const corpo = (await resposta.json()) as { data: { linhas?: unknown[] } };

    expect(corpo.data.linhas).toBeUndefined();
  });
});
