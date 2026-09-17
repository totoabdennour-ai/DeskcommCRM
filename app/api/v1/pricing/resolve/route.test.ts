import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { consultarPreco } from "@/lib/pricing/consultar";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/pricing/consultar", () => ({ consultarPreco: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PRODUTO = "66666666-6666-4666-8666-666666666666";
const CONTA = "33333333-3333-4333-8333-333333333333";

function requisicao(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/pricing/resolve?${query}`, { method: "GET" });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(consultarPreco).mockResolvedValue({
    status: "resolved",
    unit_price_cents: 499900,
    moeda: "BRL",
    fonte: "price_list",
    price_list_id: "44444444-4444-4444-8444-444444444444",
    price_list_item_id: "55555555-5555-4555-8555-555555555555",
    produto: { id: PRODUTO, codigo: "IP15", nome: "iPhone 15" },
    quantidade: 3,
  });
});

describe("GET /api/v1/pricing/resolve — o contrato canônico", () => {
  it("validação falha antes de tocar o banco", async () => {
    vi.mocked(createClient).mockResolvedValue({} as never);
    const { GET } = await import("./route");

    const semProduto = await GET(requisicao("account_id=x"));
    const produtoLixo = await GET(requisicao(`product_id=nao-uuid`));
    const qtdZero = await GET(requisicao(`product_id=${PRODUTO}&quantidade=0`));

    expect(semProduto.status).toBe(422);
    expect(produtoLixo.status).toBe(422);
    expect(qtdZero.status).toBe(422);
    expect(consultarPreco).not.toHaveBeenCalled();
  });

  it("org SEMPRE da sessão; quantidade e conta seguem o pedido", async () => {
    vi.mocked(createClient).mockResolvedValue({} as never);
    const { GET } = await import("./route");

    const resposta = await GET(requisicao(`product_id=${PRODUTO}&account_id=${CONTA}&quantidade=3`));

    expect(resposta.status).toBe(200);
    expect(consultarPreco).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG_ID,
      productId: PRODUTO,
      accountId: CONTA,
      quantidade: 3,
    });
  });

  it("sem preço a resposta é 200 com no_price + motivo (ausência é resultado, não erro)", async () => {
    vi.mocked(consultarPreco).mockResolvedValue({
      status: "no_price",
      motivo: "produto_inativo",
      produto: null,
      quantidade: 1,
    });
    vi.mocked(createClient).mockResolvedValue({} as never);
    const { GET } = await import("./route");

    const resposta = await GET(requisicao(`product_id=${PRODUTO}`));
    const corpo = (await resposta.json()) as { data: { status: string; motivo: string } };

    expect(resposta.status).toBe(200);
    expect(corpo.data).toMatchObject({ status: "no_price", motivo: "produto_inativo" });
  });
});
