import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

let gravado: Record<string, unknown> | null = null;
let orgFiltro: string | null = null;
let moedaDaOrg: string | null = "BRL";

function supabaseDeListas() {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: (_c: string, valor: string) => {
      orgFiltro = valor;
      return self;
    },
    or: () => self,
    order: () => self,
    limit: () => self,
    insert: (linha: Record<string, unknown>) => {
      gravado = linha;
      return {
        select: () => ({
          single: async () => ({ data: { id: "l1", ...linha }, error: null }),
        }),
      };
    },
    update: (valores: Record<string, unknown>) => {
      gravado = valores;
      return self;
    },
    async then(res: (r: { data: unknown; error: unknown }) => void) {
      res({ data: [{ id: "l1", nome: "Lista A", moeda: "BRL", status: "active" }], error: null });
    },
  };
  self.maybeSingle = async () => (moedaDaOrg === null ? { data: null, error: null } : { data: { currency: moedaDaOrg }, error: null });
  // O CLIENT supabase tem .from; a chain de PostgREST é o que o .from devolve.
  return { from: () => self } as unknown;
}

function requisicao(corpo: unknown, url = "http://localhost/api/v1/price-lists", method = "POST"): NextRequest {
  if (method === "GET") return new NextRequest(url, { method });
  return new NextRequest(url, {
    method,
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  gravado = null;
  orgFiltro = null;
  moedaDaOrg = "BRL";
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID },
    org: { orgId: ORG_ID },
  } as never);
});

describe("POST /api/v1/price-lists — a moeda vem da organização", () => {
  it("ignora a moeda do corpo e grava a da organização", async () => {
    moedaDaOrg = "MXN";
    vi.mocked(createClient).mockResolvedValue(supabaseDeListas() as never);
    const { POST } = await import("./route");

    const resposta = await POST(requisicao({ nome: "Lista Central", moeda: "USD" }));

    expect(resposta.status).toBe(201);
    expect(gravado).toMatchObject({ organization_id: ORG_ID, moeda: "MXN" });
  });

  it("cai na moeda padrão BRL quando a organização não responde", async () => {
    moedaDaOrg = null;
    vi.mocked(createClient).mockResolvedValue(supabaseDeListas() as never);
    const { POST } = await import("./route");

    const resposta = await POST(requisicao({ nome: "Lista Central" }));

    expect(resposta.status).toBe(201);
    expect(gravado).toMatchObject({ moeda: "BRL" });
  });
});

describe("GET /api/v1/price-lists — leitura org-flat", () => {
  it("filtra pela organização da sessão", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeListas() as never);
    const { GET } = await import("./route");

    const resposta = await GET(requisicao(null, "http://localhost/api/v1/price-lists", "GET"));

    expect(resposta.status).toBe(200);
    expect(orgFiltro).toBe(ORG_ID);
  });
});

describe("PATCH /api/v1/price-lists/[id] — muda o que veio", () => {
  it("desativar é update de status; moeda NÃO é mutável", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeListas() as never);
    const { PATCH } = await import("./[id]/route");

    const resposta = await PATCH(
      requisicao({ status: "inactive", moeda: "USD" }, "http://localhost/api/v1/price-lists/l1", "PATCH"),
      { params: Promise.resolve({ id: "l1" }) },
    );

    expect(resposta.status).toBe(200);
    expect(gravado).toEqual({ status: "inactive" });
  });
});
