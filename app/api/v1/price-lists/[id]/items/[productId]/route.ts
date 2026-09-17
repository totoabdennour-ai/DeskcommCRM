import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * DELETE /api/v1/price-lists/:id/items/:productId — tira o produto da lista.
 *
 * Tirar da lista DEVOLVE o produto ao preço base do catálogo para as contas
 * desta lista (A1 do resolver) — é operação comercial normal, audita
 * (`price_list_item.removed`) e não apaga produto algum (o CASCADE do banco é
 * só no sentido produto→item, quando o produto é removido do catálogo).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; productId: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "price_lists" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id, productId } = await ctx.params;

  const supabase = await createClient();

  // O delete confere que a linha existia ANTES (mesma regra de products/[id]):
  // sem isso, um DELETE barrado pela RLS devolveria sucesso e gravaria
  // auditoria de uma mutação que não aconteceu.
  const { data: anterior } = await supabase
    .from("price_list_items")
    .select("id, preco_cents")
    .eq("organization_id", authz.org.orgId)
    .eq("price_list_id", id)
    .eq("product_id", productId)
    .maybeSingle();
  if (!anterior) {
    return fail("not_found", t("Preço não encontrado nesta lista."), 404, { requestId });
  }

  const { error } = await supabase
    .from("price_list_items")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("price_list_id", id)
    .eq("product_id", productId);

  if (error) {
    return fail("internal_error", t("Erro ao remover o preço da lista."), 500, { requestId });
  }

  await audit({
    action: "price_list_item.removed",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "price_list_item",
    resourceId: (anterior as { id: string }).id,
    requestId,
    metadata: { price_list_id: id, product_id: productId },
  });

  return ok({ removed: true }, { requestId });
}
