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

/**
 * GET /api/v1/accounts/:id — Account 360 (Fase 6, doc 28 §7): o contrato de
 * dados comercial da conta, montado só com leituras org-scoped. A UI é da
 * F7 — esta rota É o contrato.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "accounts" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();

  const { data: conta } = await supabase
    .from("accounts")
    .select(COLUNAS_DA_CONTA)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!conta) return fail("not_found", t("Conta não encontrada."), 404, { requestId });

  const { data: contatos } = await supabase
    .from("contacts")
    .select("id, display_name, phone_number, last_activity_at")
    .eq("organization_id", authz.org.orgId)
    .eq("account_id", id)
    .order("last_activity_at", { ascending: false, nullsFirst: false })
    .limit(50);

  const idsDeContato = (contatos ?? []).map((c) => (c as { id: string }).id);
  const [opps, ords, rsk, evs] = await Promise.all([
    supabase
      .from("crm_leads")
      .select("id, title, status, value_cents, currency, stage_id, lost_reason")
      .eq("organization_id", authz.org.orgId)
      .in("contact_id", idsDeContato.length > 0 ? idsDeContato : ["00000000-0000-4000-8000-000000000000"])
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("orders")
      .select(
        "id, external_id, origin, status, total_cents, currency, ordered_at, created_at",
      )
      .eq("organization_id", authz.org.orgId)
      .eq("account_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("revenue_at_risk")
      .select(
        "id, risk_type, status, trigger_detail, estimated_value_cents, currency, nba_action, nba_reason, deadline_at, detected_at",
      )
      .eq("organization_id", authz.org.orgId)
      .eq("account_id", id)
      .order("detected_at", { ascending: false })
      .limit(50),
    supabase
      .from("revenue_events")
      .select("event_kind, lineage, value_cents, currency, occurred_at, source_kind, source_id")
      .eq("organization_id", authz.org.orgId)
      .eq("account_id", id)
      .order("occurred_at", { ascending: false })
      .limit(100),
  ]);

  // Valores SOMADOS a partir das linhas já lidas (determinístico, na moeda
  // nativa de cada linha — consolidação multi-moeda segue deferida, doc 28).
  const receitaConfirmada = ((ords.data ?? []) as Array<{ status: string; total_cents: number; currency: string }>)
    .filter((p) => ["confirmed", "fulfilled", "delivered", "closed"].includes((p as { status: string }).status))
    .map((p) => (p as { total_cents: number; currency: string }));

  type LinhaDeRisco = {
    status: string;
    risk_type: string;
    nba_action: string;
    nba_reason: string;
    estimated_value_cents: number | null;
    deadline_at: string | null;
    detected_at: string;
  };
  const riscos = ((rsk.data ?? []) as unknown as LinhaDeRisco[]);
  const riscosAbertos = riscos.filter((r) => r.status === "open");
  const recuperados = riscos.filter((r) => r.status === "resolved");

  return ok(
    {
      conta,
      contatos: contatos ?? [],
      oportunidades: (opps.data ?? []) as unknown as Array<{ id: string; title: string | null; status: string; value_cents: number | null; currency: string | null; stage_id: string; lost_reason: string | null }>,
      pedidos: (ords.data ?? []) as unknown as Array<{ id: string; external_id: string; origin: string; status: string; total_cents: number; currency: string; ordered_at: string | null; created_at: string }>,
      receita: {
        confirmada: receitaConfirmada,
        total_confirmado_cents: receitaConfirmada.reduce((a, p) => a + p.total_cents, 0),
        moeda: conta ? (conta as { settings: Record<string, unknown> }).settings : null,
        nota: "consolidação multi-moeda deferida (doc 28 §A4/17-Q3)",
      },
      revenue_at_risk: { abertos: riscosAbertos, todos: riscos },
      recuperados,
      eventos_receita: (evs.data ?? []) as unknown as Array<{ event_kind: string; lineage: string; value_cents: number | null; currency: string | null; occurred_at: string; source_kind: string; source_id: string }>,
      proximas_acoes: riscosAbertos
        .filter((r) => (r as { nba_action: string }).nba_action)
        .map((r) => ({
          nba_action: (r as { nba_action: string }).nba_action,
          nba_reason: (r as { nba_reason: string }).nba_reason,
          deadline_at: (r as { deadline_at: string | null }).deadline_at,
        })),
    },
    { requestId },
  );
}
