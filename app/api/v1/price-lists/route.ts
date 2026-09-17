import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/price-lists — as listas de preço da organização ativa (0240).
 * POST /api/v1/price-lists — cria uma lista.
 *
 * A lista SOBREPÕE o preço base do catálogo para as contas que apontam para
 * ela (`accounts.price_list_id`). A resolução é do resolver (`lib/pricing/`) —
 * esta rota só cadastra. Moeda default = a que a organização declarou
 * (`moedaDaOrganizacao`), o MESMO caminho do catálogo.
 *
 * Leitura para a organização; ESCRITA `manager`+: preço é dinheiro (mesma
 * régua de `catalog_products` e `accounts`). Toda mutação audita.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { COLUNAS_DA_LISTA, listaCreateSchema } from "@/lib/schemas/precos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "price_lists" });
  if (!authz.ok) return authz.response;

  const busca = req.nextUrl.searchParams.get("busca")?.trim() ?? "";
  const supabase = await createClient();

  let q = supabase
    .from("price_lists")
    .select(COLUNAS_DA_LISTA)
    .eq("organization_id", authz.org.orgId);

  if (busca !== "") q = q.or(`nome.ilike.%${busca}%`);

  const { data, error } = await q
    .order("status", { ascending: true })
    .order("nome")
    .limit(200);

  if (error) return fail("internal_error", "Erro ao listar as listas de preço.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "price_lists" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = listaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  const linha = {
    organization_id: authz.org.orgId,
    nome: parsed.data.nome,
    // A moeda NÃO vem do corpo (nunca decide unidade — CLAUDE.md): default é a
    // que a organização declarou, o mesmo caminho do catálogo. Explícita no
    // insert porque o schema nem declara o campo — Zod descarta.
    moeda: parsed.data.moeda ?? (await moedaDaOrganizacao(supabase, authz.org.orgId)),
    status: parsed.data.status,
    created_by: authz.user.id,
  };

  const { data, error } = await supabase
    .from("price_lists")
    .insert(linha)
    .select(COLUNAS_DA_LISTA)
    .single();

  if (error) {
    return fail("internal_error", t("Erro ao criar a lista de preço."), 500, { requestId });
  }

  await audit({
    action: "price_list.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "price_list",
    resourceId: (data as { id: string }).id,
    requestId,
    metadata: { nome: parsed.data.nome, moeda: linha.moeda },
  });

  return ok(data, { requestId, status: 201 });
}
