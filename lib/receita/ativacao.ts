/**
 * WRAPPERS DA ATIVAÇÃO (Fase 6) — a ponte TypeScript para as RPCs 0242.
 *
 * Regras: detectores rodam via cron com ADMIN client (`fn_materializar_riscos`
 * é service_role-only); atribuição roda na confirmação com o client da sessão
 * (`fn_atribuir_receita` valida membership via `fn_guarda_acesso_org`).
 * A IA NUNCA chama estas funções diretamente — ela usa as tools MCP, e as
 * tools decidem o que materializar (apenas recusas de preço, com valor null).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ContagemDeRiscos {
  inquiry_without_response: number;
  stalled_opportunity: number;
  abandoned_draft_order: number;
  dormant_customer: number;
  unresolved_open_state: number;
}

export interface ResultadoDaMaterializacao {
  contagem: ContagemDeRiscos;
}

/** Cron: materializa os detectores para todas as orgs ativas (service_role). */
export async function materializarRiscos(
  admin: SupabaseClient,
  orgId?: string,
): Promise<ResultadoDaMaterializacao> {
  const { data, error } = await admin.rpc("fn_materializar_riscos", {
    p_org: orgId ?? null,
  });
  if (error) throw new Error(`fn_materializar_riscos: ${error.message}`);
  return {
    contagem: (data ?? {}) as ContagemDeRiscos,
  };
}

/** Atribuição conservadora na confirmação (idempotente — dedup por fonte). */
export async function atribuirReceita(
  supabase: SupabaseClient,
  entrada: { organizationId: string; orderId: string },
): Promise<{ recuperados: number; influenciado: boolean }> {
  const { data, error } = await supabase.rpc("fn_atribuir_receita", {
    p_org: entrada.organizationId,
    p_order: entrada.orderId,
  });
  if (error) throw new Error(`fn_atribuir_receita: ${error.message}`);
  const r = (data ?? {}) as { recuperados?: number; influenciado?: boolean };
  return { recuperados: r.recuperados ?? 0, influenciado: r.influenciado === true };
}
