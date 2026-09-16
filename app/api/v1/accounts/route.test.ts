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

/** O que a rota mandou para o `insert` / `update`. */
let gravado: Record<string, unknown> | null = null;
/** Filtro de organização aplicado à query — o escopo vem de fonte confiável. */
let orgFiltro: string | null = null;
/** Código de erro que o "banco" devolve (ex.: 23505 do índice parcial). */
let erroDoBanco: { code: string; message: string } | null = null;
/** A linha existe no banco (false = update de 0 linhas → 404). */
let linhaExiste = true;

function supabaseDeContas() {
  return {
    from: (tabela: string) => {
      if (tabela !== "accounts") {
        throw new Error(`tabela inesperada no dublê: ${tabela}`);
      }
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
              single: async () =>
                erroDoBanco
                  ? { data: null, error: erroDoBanco }
                  : { data: { id: "a1", ...linha }, error: null },
            }),
          };
        },
        update: (valores: Record<string, unknown>) => {
          gravado = valores;
          return self;
        },
        async then(res: (r: { data: unknown; error: unknown }) => void) {
          // Fim da corrente de LEITURA (GET): devolve uma conta da org.
          res({ data: [{ id: "a1", name: "Distribuidora A" }], error: null });
        },
      };
      // O PATCH termina em maybeSingle, não em then — mesma corrente, saída própria.
      (self as { maybeSingle?: unknown }).maybeSingle = async () =>
        erroDoBanco
          ? { data: null, error: erroDoBanco }
          : linhaExiste
            ? { data: { id: "a1", ...(gravado ?? {}) }, error: null }
            : { data: null, error: null };
      return self;
    },
  };
}

function requisicao(corpo: unknown, url = "http://localhost/api/v1/accounts", method = "POST"): NextRequest {
  // GET/HEAD não aceitam body (NextRequest recusa na construção).
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
  erroDoBanco = null;
  linhaExiste = true;
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID },
    org: { orgId: ORG_ID },
  } as never);
});

describe("POST /api/v1/accounts — a organização vem de fonte confiável", () => {
  /**
   * ⚠️ SABOTAGEM multi-tenant: `organization_id` no corpo NUNCA decide
   * (CLAUDE.md) — a conta nasce na org do requireRole, e o filtro de leitura
   * usa o MESMO orgId. Se um dia a rota aceitar org do body, este teste é o
   * primeiro a quebrar.
   */
  it("ignora organization_id do corpo e grava o da sessão", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeContas() as never);
    const { POST } = await import("./route");

    const resposta = await POST(
      requisicao({ name: "Distribuidora Central", organization_id: "99999999-9999-4999-8999-999999999999" }),
    );

    expect(resposta.status).toBe(201);
    expect(gravado).toMatchObject({ organization_id: ORG_ID, name: "Distribuidora Central" });
  });

  it("referência externa duplicada devolve 409 legível (23505 do índice parcial)", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeContas() as never);
    erroDoBanco = { code: "23505", message: "duplicate key" };
    const { POST } = await import("./route");

    const resposta = await POST(requisicao({ name: "X", external_id: "ERP-42" }));

    expect(resposta.status).toBe(409);
  });

  it("status fora do vocabulário do banco vira 422 antes de tocar o banco", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeContas() as never);
    const { POST } = await import("./route");

    const resposta = await POST(requisicao({ name: "X", status: "suspended" }));

    expect(resposta.status).toBe(422);
    expect(gravado).toBeNull();
  });
});

describe("GET /api/v1/accounts — leitura org-flat", () => {
  it("filtra pela organização da sessão, nunca do query string", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeContas() as never);
    const { GET } = await import("./route");

    const resposta = await GET(requisicao(null, "http://localhost/api/v1/accounts?busca=distrib", "GET"));

    expect(resposta.status).toBe(200);
    expect(orgFiltro).toBe(ORG_ID);
  });
});

describe("PATCH /api/v1/accounts/[id] — muda o que veio", () => {
  it("arquivar é update de status; não existe DELETE", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeContas() as never);
    const { PATCH } = await import("./[id]/route");

    const resposta = await PATCH(
      requisicao({ status: "archived" }, "http://localhost/api/v1/accounts/a1", "PATCH"),
      { params: Promise.resolve({ id: "a1" }) },
    );

    expect(resposta.status).toBe(200);
    expect(gravado).toMatchObject({ status: "archived" });
  });

  it("conta inexistente (ou de outra org — RLS devolve 0 linhas) vira 404, sem fantasma", async () => {
    vi.mocked(createClient).mockResolvedValue(supabaseDeContas() as never);
    linhaExiste = false;
    const { PATCH } = await import("./[id]/route");

    const resposta = await PATCH(
      requisicao({ name: "Outra" }, "http://localhost/api/v1/accounts/inexistente", "PATCH"),
      { params: Promise.resolve({ id: "inexistente" }) },
    );

    expect(resposta.status).toBe(404);
  });
});

// (o mock do suporte de plataforma é mínimo de propósito: as rotas desta
// família só tocam `requireSupportWrite` antes de qualquer trabalho — o resto
// do módulo não é alcançado por este handler.)
