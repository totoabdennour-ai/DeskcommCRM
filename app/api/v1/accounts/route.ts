import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/accounts — as contas B2B da organização ativa (Fase 2, 0239).
 * POST /api/v1/accounts — cadastra uma conta.
 *
 * A conta é a EMPRESA-CLIENTE do tenant (RevenueOS): camada ACIMA de
 * `contacts`, ligada por `contacts.account_id` (opcional — B2C segue sem).
 * Leitura para a organização; ESCRITA exige `manager`: condições comerciais
 * (preço por conta, MOQ, rep) entram por ela na Fase 3-4, e é o mesmo molde
 * de `catalog_products`. RLS é a barreira de tenant; o papel é a barreira de
 * superfície.
 *
 * NÃO existe DELETE: o ciclo de vida é `status` (`archived`) — remover conta
 * com FKs apontando seria decidir o que acontece com contatos por trás do
 * operador, e o banco não adivinha.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DA_CONTA, contaCreateSchema } from "@/lib/schemas/contas";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "accounts" });
  if (!authz.ok) return authz.response;

  const busca = req.nextUrl.searchParams.get("busca")?.trim() ?? "";
  const supabase = await createClient();

  let q = supabase
    .from("accounts")
    .select(COLUNAS_DA_CONTA)
    .eq("organization_id", authz.org.orgId);

  // Mesma filosofia da busca de produtos: substring simples, porque é a busca
  // de OPERAÇÃO (o operador digita o nome como cadastrou) — não a de resolução.
  if (busca !== "") {
    q = q.or(`name.ilike.%${busca}%,external_id.ilike.%${busca}%`);
  }

  const { data, error } = await q
    .order("status", { ascending: true })
    .order("name")
    .limit(500);

  if (error) return fail("internal_error", "Erro ao listar as contas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "accounts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = contaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  const linha = {
    organization_id: authz.org.orgId,
    name: parsed.data.name,
    external_id: parsed.data.external_id ?? null,
    status: parsed.data.status,
    owner_user_id: parsed.data.owner_user_id ?? null,
    settings: parsed.data.settings ?? {},
    created_by: authz.user.id,
  };

  const { data, error } = await supabase
    .from("accounts")
    .insert(linha)
    .select(COLUNAS_DA_CONTA)
    .single();

  if (error) {
    // 23505 = índice parcial `accounts_org_external_id_unique`: a referência
    // externa é o identity do operador — duplicar silenciosamente criaria DUAS
    // contas "iguais" para pricing/order da Fase 3-4.
    if (error.code === "23505") {
      return fail("validation_failed", t("Já existe conta com essa referência externa."), 409, {
        requestId,
      });
    }
    return fail("internal_error", t("Erro ao criar a conta."), 500, { requestId });
  }

  await audit({
    action: "account.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "account",
    resourceId: (data as { id: string }).id,
    requestId,
    metadata: { name: parsed.data.name, external_id: parsed.data.external_id ?? null },
  });

  return ok(data, { requestId, status: 201 });
}
