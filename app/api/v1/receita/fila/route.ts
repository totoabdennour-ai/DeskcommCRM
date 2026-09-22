import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { priorizar } from "@/lib/receita/nba";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/receita/fila — A FILA DO OPERADOR (Fase 7).
 *
 * Riscos abertos da organização, ORDENADOS pela prioridade determinística da
 * NBA (`lib/receita/nba.ts` — severidade → prazo → valor; sem score opaco).
 * Cada linha carrega a conta (nome), o motivo legível, o valor estimado
 * (authoritative — calculado na materialização pela SQL, nunca aqui), o
 * deadline, a ação sugerida e os links de destino (pedido/conversa).
 *
 * Leitura viewer+ (fila é informação de operação); ações individuais usam as
 * rotas/autorizações já existentes — esta rota NÃO muta nada.
 */
export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "revenue_at_risk" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();

  const { data: riscos, error } = await supabase
    .from("revenue_at_risk")
    .select(
      "id, risk_type, source_kind, source_id, account_id, contact_id, lead_id, order_id, trigger_detail, estimated_value_cents, currency, owner_user_id, deadline_at, nba_action, nba_reason, status, detected_at",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("status", "open")
    .order("deadline_at", { ascending: true, nullsFirst: false })
    .limit(200);

  if (error) return fail("internal_error", "Erro ao carregar a fila de receita.", 500, { requestId });

  const linhas = (riscos ?? []) as unknown as Array<{
    id: string;
    risk_type: string;
    source_kind: string;
    source_id: string;
    account_id: string | null;
    order_id: string | null;
    trigger_detail: string;
    estimated_value_cents: number | null;
    currency: string | null;
    deadline_at: string | null;
    nba_action: string;
    nba_reason: string;
    detected_at: string;
  }>;

  // Nomes de conta em lote (uma leitura a mais, org-scoped — nunca o nome vem
  // de fora para dentro).
  const idsDeConta = [...new Set(linhas.map((l) => l.account_id).filter((v): v is string => v !== null))];
  const nomes = new Map<string, string>();
  if (idsDeConta.length > 0) {
    const { data: contas } = await supabase
      .from("accounts")
      .select("id, name")
      .eq("organization_id", authz.org.orgId)
      .in("id", idsDeConta);
    for (const c of (contas ?? []) as Array<{ id: string; name: string }>) {
      nomes.set(c.id, c.name);
    }
  }

  // Prioridade determinística da NBA (pura — doc 28 §4): severidade → prazo → valor.
  // Genérica: cada linha atravessa a ordenação com TODOS os seus campos.
  const fila = priorizar(linhas);

  const filaCompleta = fila.map((r) => ({
    id: r.id,
    risk_type: r.risk_type,
    source_kind: r.source_kind,
    source_id: r.source_id,
    account_id: r.account_id,
    account_name: r.account_id ? (nomes.get(r.account_id) ?? null) : null,
    order_id: r.order_id,
    motivo: r.trigger_detail,
    estimated_value_cents: r.estimated_value_cents,
    currency: r.currency,
    deadline_at: r.deadline_at,
    nba_action: r.nba.action,
    nba_reason: r.nba.reason,
    detected_at: r.detected_at,
  }));

  return ok(filaCompleta, { requestId });
}
