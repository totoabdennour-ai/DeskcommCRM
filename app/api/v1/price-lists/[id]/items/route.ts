import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/price-lists/:id/items — os preços da lista (com o produto).
 * PUT  /api/v1/price-lists/:id/items — UPSERT do preço de um produto na lista.
 *
 * O upsert é determinístico pelo unique (price_list_id, product_id): setar o
 * MESMO produto duas vezes é UM preço, não dois — e o on_conflict devolve a
 * linha final, que é o que a tela renderiza. Mutações audita
 * (`price_list_item.set`), porque "quem mudou o preço desta conta e quando"
 * é a primeira pergunta de uma disputa comercial.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_ITEM, itemUpsertSchema } from "@/lib/schemas/precos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "price_lists" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("price_list_items")
    .select(COLUNAS_DO_ITEM)
    .eq("organization_id", authz.org.orgId)
    .eq("price_list_id", id)
    .order("created_at");

  if (error) return fail("internal_error", "Erro ao listar os preços da lista.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "price_lists" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const parsed = itemUpsertSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // A lista tem de existir NA ORG antes de receber preço (o trigger do banco
  // recusaria de qualquer forma; aqui o operador recebe 404 legível).
  const { data: lista } = await supabase
    .from("price_lists")
    .select("id")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!lista) {
    return fail("not_found", t("Lista de preço não encontrada."), 404, { requestId });
  }

  const { data, error } = await supabase
    .from("price_list_items")
    .upsert(
      {
        organization_id: authz.org.orgId,
        price_list_id: id,
        product_id: parsed.data.product_id,
        preco_cents: parsed.data.preco_cents,
      },
      { onConflict: "price_list_id,product_id" },
    )
    .select(COLUNAS_DO_ITEM)
    .single();

  if (error) {
    // O trigger same-org do banco fala 23514: se chegou aqui, é bug de rota
    // (a lista já foi validada) ou de produto de outra org — 422 honesto.
    if (error.code === "23514") {
      return fail(
        "validation_failed",
        t("Produto ou lista não pertencem a esta organização."),
        422,
        { requestId },
      );
    }
    return fail("internal_error", t("Erro ao gravar o preço."), 500, { requestId });
  }

  await audit({
    action: "price_list_item.set",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "price_list_item",
    resourceId: (data as { id: string }).id,
    requestId,
    metadata: {
      price_list_id: id,
      product_id: parsed.data.product_id,
      preco_cents: parsed.data.preco_cents,
    },
  });

  return ok(data, { requestId });
}
