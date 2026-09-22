import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/receita/resumo — as métricas mínimas de receita da organização
 * (Fase 7, doc 28 §8). TODAS as somas vêm das tabelas authoritative/derived
 * (orders confirmadas, revenue_events, revenue_at_risk, crm_leads) — o
 * servidor agrega por moeda nativa; o browser nunca calcula receita.
 * Consolidação multi-moeda segue deferida (doc 28 §A4/17-Q3).
 */
export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "receita" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();

  const [opps, pedidos, riscos, evs] = await Promise.all([
    supabase
      .from("crm_leads")
      .select("id, value_cents, currency")
      .eq("organization_id", authz.org.orgId)
      .eq("status", "open"),
    supabase
      .from("orders")
      .select("id, status, total_cents, currency, origin")
      .eq("organization_id", authz.org.orgId),
    supabase
      .from("revenue_at_risk")
      .select("id, status, estimated_value_cents, currency, risk_type")
      .eq("organization_id", authz.org.orgId),
    supabase
      .from("revenue_events")
      .select("event_kind, value_cents, currency")
      .eq("organization_id", authz.org.orgId),
  ]);

  const somaPorMoeda = (linhas: Array<{ total_cents: number; currency: string }>) => {
    const porMoeda: Record<string, number> = {};
    for (const l of linhas) {
      porMoeda[l.currency] = (porMoeda[l.currency] ?? 0) + l.total_cents;
    }
    return Object.entries(porMoeda).map(([moeda, total_cents]) => ({ moeda, total_cents }));
  };

  const oportunidadesAbertas = (opps.data ?? []) as Array<{ value_cents: number | null; currency: string | null }>;
  const todasOsPedidos = (pedidos.data ?? []) as Array<{ status: string; total_cents: number; currency: string; origin: string }>;
  const confirmados = todasOsPedidos.filter((p) =>
    ["confirmed", "fulfilled", "delivered", "closed"].includes(p.status),
  );
  const riscosAbertos = ((riscos.data ?? []) as Array<{ status: string; estimated_value_cents: number | null; currency: string | null; risk_type: string }>).filter(
    (r) => r.status === "open",
  );
  const eventosReceita = (evs.data ?? []) as Array<{ event_kind: string; value_cents: number | null; currency: string | null }>;

  const somaEventos = (kind: string) =>
    somaPorMoeda(
      eventosReceita
        .filter((e) => e.event_kind === kind && e.value_cents !== null)
        .map((e) => ({ total_cents: e.value_cents!, currency: e.currency ?? "—" })),
    );

  return ok(
    {
      oportunidades_abertas: {
        count: oportunidadesAbertas.length,
        valor_por_moeda: somaPorMoeda(
          oportunidadesAbertas.map((o) => ({
            total_cents: o.value_cents ?? 0,
            currency: o.currency ?? "—",
          })),
        ),
      },
      revenue_at_risk: {
        count: riscosAbertos.length,
        valor_por_moeda: somaPorMoeda(
          riscosAbertos.map((r) => ({
            total_cents: r.estimated_value_cents ?? 0,
            currency: r.currency ?? "—",
          })),
        ),
        por_tipo: Object.entries(
          riscosAbertos.reduce<Record<string, number>>((acc, r) => {
            acc[r.risk_type] = (acc[r.risk_type] ?? 0) + 1;
            return acc;
          }, {}),
        ).map(([risk_type, count]) => ({ risk_type, count })),
      },
      receita_direta_por_moeda: somaEventos("order_confirmed"),
      receita_recuperada_por_moeda: somaEventos("recovery_succeeded"),
      receita_influenciada_por_moeda: somaEventos("revenue_influenced"),
      pedidos: {
        criados: todasOsPedidos.filter((p) => p.origin === "manual" && p.status !== "cancelled").length,
        confirmados: confirmados.length,
      },
      itens_nao_resolvidos: riscosAbertos.length,
      nota: "somas em moeda NATIVA por linha; consolidação multi-moeda deferida (doc 28 §A4/17-Q3)",
    },
    { requestId },
  );
}
