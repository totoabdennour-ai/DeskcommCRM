import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/orders/:id/confirm — draft → confirmed (A6/B1).
 *
 * O snapshot é FRESCO: todas as linhas são RE-RESOLVIDAS agora (o preço vale
 * no instante da confirmação; o rascunho mostrou preço vivo até aqui) e
 * `fn_confirmar_pedido` substitui as linhas, recalcula o total, vira
 * `confirmed` e registra o evento NO MESMO COMMIT.
 *
 * É decisão de OPERADOR (manager+): a IA cria rascunho e explica preço, mas
 * NÃO confirma (doc 25 B1 — gate humano por default). Nenhuma tool MCP de
 * confirmação existe e nenhuma nasce sem decisão do dono.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { confirmar } from "@/lib/orders/engine";
import { pedidoCreateSchema } from "@/lib/orders/tipos";
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

  // As linhas confirmadas são as DO CORPO (o operador reenvia o rascunho que
  // revisou) — e o resolver re-resolve cada uma agora; o total é recalculado.
  const parsed = pedidoCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  const { data: pedido } = await supabase
    .from("orders")
    .select("id, status, account_id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!pedido) {
    return fail("not_found", t("Pedido não encontrado."), 404, { requestId });
  }
  const linhaDoPedido = pedido as { status: string; account_id: string | null };
  if (linhaDoPedido.status !== "draft") {
    return fail("validation_failed", t("Só rascunho pode ser confirmado."), 409, { requestId });
  }
  if (!linhaDoPedido.account_id) {
    return fail("validation_failed", t("Pedido sem conta."), 422, { requestId });
  }

  try {
    const r = await confirmar(supabase, {
      organizationId: authz.org.orgId,
      orderId: id,
      accountId: linhaDoPedido.account_id,
      linhas: parsed.data.items,
      actorUserId: authz.user.id,
      actorKind: "user",
    });
    if (!r.ok) {
      return fail("validation_failed", t(`Pedido recusado: ${r.motivo}.`), 422, {
        requestId,
        details: { motivo: r.motivo, produto: r.produto },
      });
    }

    await audit({
      action: "order.confirmed",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "order",
      resourceId: id,
      requestId,
      metadata: { total_cents: r.total_cents },
    });

    return ok({ order_id: id, status: "confirmed", total_cents: r.total_cents }, { requestId });
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    if (mensagem.includes("23514") || mensagem.includes("nao pode ser confirmado")) {
      return fail("validation_failed", t("Só rascunho pode ser confirmado."), 409, { requestId });
    }
    return fail("internal_error", t("Erro ao confirmar o pedido."), 500, { requestId });
  }
}
