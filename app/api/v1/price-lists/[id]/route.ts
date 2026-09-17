import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH /api/v1/price-lists/:id — muda o que veio (nome/status/moeda não: a
 * moeda da lista é fixada na criação — mudá-la trocaria a moeda de TODOS os
 * itens de uma tacada, e é exatamente o tipo de mutação silenciosa que uma
 * disputa comercial não perdoa; quem precisa de outra moeda cria outra lista).
 *
 * Sem DELETE: o ciclo de vida é `status` (`inactive`) — contatos apontando
 * para a lista e itens de preço não desaparecem por trás do operador.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DA_LISTA, listaPatchSchema } from "@/lib/schemas/precos";
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
  const authz = await requireRole("manager", { requestId, resource: "price_lists" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await params;

  // Moeda NÃO é mutável (fixada na criação pela moeda da organização — mudá-la
  // trocaria a moeda de TODOS os itens de uma tacada); o schema nem a declara.
  const parsed = listaPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("price_lists")
    .update(parsed.data)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(COLUNAS_DA_LISTA)
    .maybeSingle();

  if (error) {
    return fail("internal_error", t("Erro ao atualizar a lista de preço."), 500, { requestId });
  }
  if (!data) {
    return fail("not_found", t("Lista de preço não encontrada."), 404, { requestId });
  }

  await audit({
    action: "price_list.updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "price_list",
    resourceId: id,
    requestId,
    metadata: { campos: Object.keys(parsed.data) },
  });

  return ok(data, { requestId });
}
