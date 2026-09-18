import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { editarRascunho } from "@/lib/orders/engine";
import { pedidoPatchSchema } from "@/lib/orders/tipos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const COLUNAS =
  "id, organization_id, external_id, external_provider, origin, account_id, contact_id, status, total_cents, currency, payment_method, fulfillment_status, tracking_code, ordered_at, created_at, updated_at";

/** GET /api/v1/orders/:id — o pedido completo: cabeçalho + linhas + eventos. */
export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "orders" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  const supabase = await createClient();

  const { data: pedido, error } = await supabase
    .from("orders")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao carregar o pedido.", 500, { requestId });
  if (!pedido) return fail("not_found", "Pedido não encontrado.", 404, { requestId });

  const [{ data: itens }, { data: eventos }] = await Promise.all([
    supabase
      .from("order_items")
      .select(
        "id, product_id, sku, nome, quantity, unit_price_cents, moeda, fonte, price_list_id, price_list_item_id, resolvido_em, created_at",
      )
      .eq("organization_id", authz.org.orgId)
      .eq("order_id", id)
      .order("created_at"),
    supabase
      .from("order_events")
      .select("id, seq, kind, payload, actor_kind, actor_user_id, created_at")
      .eq("organization_id", authz.org.orgId)
      .eq("order_id", id)
      .order("seq"),
  ]);

  return ok({ pedido, itens: itens ?? [], eventos: eventos ?? [] }, { requestId });
}

/**
 * PATCH /api/v1/orders/:id — edita o RASCUNHO (só draft): substitui as linhas
 * pela resolução FRESCA (o rascunho mostra preço VIVO — doc 25 A6) e
 * recalcula o total. Confirmado é IMUTÁVEL por esta rota (emenda de
 * confirmado: F7 — cancela e refaz).
 */
export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "orders" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const parsed = pedidoPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // O rascunho precisa existir na org E ter conta (a resolução de preço é por
  // conta). Checks legíveis antes de tocar o RPC (o banco é a autoridade).
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
    return fail("validation_failed", t("Só rascunho pode ser editado."), 409, { requestId });
  }
  if (!linhaDoPedido.account_id) {
    return fail("validation_failed", t("Pedido sem conta — não há como resolver preço."), 422, {
      requestId,
    });
  }

  try {
    const r = await editarRascunho(supabase, {
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
      action: "order.updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "order",
      resourceId: id,
      requestId,
      metadata: { total_cents: r.total_cents, itens: parsed.data.items.length },
    });

    return ok({ order_id: id, status: "draft", total_cents: r.total_cents }, { requestId });
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    if (mensagem.includes("23514") || mensagem.includes("só rascunho")) {
      return fail("validation_failed", t("Só rascunho pode ser editado."), 409, { requestId });
    }
    return fail("internal_error", t("Erro ao editar o rascunho."), 500, { requestId });
  }
}
