import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/orders/:id/cancel — draft|confirmed → cancelled, com motivo
 * obrigatório (cancelamento sem motivo faz alguém ligar para o cliente
 * perguntando o que houve). O evento `cancelled` carrega o motivo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { cancelar } from "@/lib/orders/engine";
import { pedidoCancelSchema } from "@/lib/orders/tipos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "orders" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const parsed = pedidoCancelSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Motivo do cancelamento é obrigatório."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  try {
    await cancelar(supabase, {
      organizationId: authz.org.orgId,
      orderId: id,
      motivo: parsed.data.motivo,
      actorUserId: authz.user.id,
      actorKind: "user",
    });
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    if (mensagem.includes("23514") || mensagem.includes("nao pode ser cancelado")) {
      return fail("validation_failed", t("Pedido não pode ser cancelado neste estado."), 409, {
        requestId,
      });
    }
    if (mensagem.includes("nao encontrado")) {
      return fail("not_found", t("Pedido não encontrado."), 404, { requestId });
    }
    return fail("internal_error", t("Erro ao cancelar o pedido."), 500, { requestId });
  }

  await audit({
    action: "order.cancelled",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "order",
    resourceId: id,
    requestId,
    metadata: { motivo: parsed.data.motivo },
  });

  return ok({ order_id: id, status: "cancelled" }, { requestId });
}
