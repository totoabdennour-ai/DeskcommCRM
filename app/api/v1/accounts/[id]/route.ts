import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/accounts/:id — muda o que veio, não encosta no resto.
 *
 * O id vai no PATH, e a existência ANTES da mutação é conferida pelo update
 * em si (0 linhas = 404, sem auditoria de mutação fantasma). O ciclo de vida
 * vive em `status` (`archived` arquiva) — não há DELETE: contatos podem estar
 * vinculados e o banco não adivinha o que fazer com eles por trás do
 * operador.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DA_CONTA, contaPatchSchema } from "@/lib/schemas/contas";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "accounts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  const parsed = contaPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // Lista de preço (0240): tem de ser DA ORGANIZAÇÃO (gatilho do banco é a
  // autoridade; aqui o operador recebe 422 legível). `null` desvincula — a
  // conta volta ao preço base do catálogo.
  if (parsed.data.price_list_id) {
    const { data: lista } = await supabase
      .from("price_lists")
      .select("id")
      .eq("id", parsed.data.price_list_id)
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    if (!lista) {
      return fail("validation_failed", t("Lista de preço não encontrada nesta organização."), 422, {
        requestId,
      });
    }
  }

  const { data, error } = await supabase
    .from("accounts")
    .update(parsed.data)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(COLUNAS_DA_CONTA)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return fail("validation_failed", t("Já existe conta com essa referência externa."), 409, {
        requestId,
      });
    }
    return fail("internal_error", t("Erro ao atualizar a conta."), 500, { requestId });
  }
  if (!data) {
    return fail("not_found", t("Conta não encontrada."), 404, { requestId });
  }

  await audit({
    action: "account.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "account",
    resourceId: id,
    requestId,
    metadata: { campos: Object.keys(parsed.data) },
  });

  return ok(data, { requestId });
}
