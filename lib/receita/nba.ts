/**
 * NBA — NEXT BEST ACTION (Fase 6, doc 28 §4): a PRIORIDADE é uma função pura
 * e explicável — sem score opaco, sem LLM. A IA lê o resultado e EXECUTA a
 * ação autorizada; ela nunca define elegibilidade, prioridade ou valor.
 *
 * Severidade fixa por tipo (dinheiro já comprometido > cliente quente >
 * linha bloqueada > esfriando > sem dono):
 *   abandoned_draft_order > inquiry_without_response > no_price >
 *   stalled_opportunity > dormant_customer > unresolved_open_state
 */

export type AcaoNBA =
  | "follow_up_customer"
  | "request_missing_quantity"
  | "clarify_product"
  | "request_human_pricing_review"
  | "request_confirmation"
  | "reactivate_customer";

export interface RiscoParaNBA {
  risk_type: string;
  estimated_value_cents: number | null;
  deadline_at: string | null;
}

export interface NbaSelecionada {
  action: AcaoNBA;
  reason: string;
  /** rank menor = mais urgente (documentado em SEVERIDADE). */
  rank: number;
}

const SEVERIDADE: Record<string, number> = {
  abandoned_draft_order: 1,
  inquiry_without_response: 2,
  no_price: 3,
  stalled_opportunity: 4,
  dormant_customer: 5,
  unresolved_open_state: 6,
};

const ACAO_POR_TIPO: Record<string, { action: AcaoNBA; reason: string }> = {
  abandoned_draft_order: {
    action: "request_confirmation",
    reason: "Pedido montado e abandonado — retomar o rascunho e pedir a confirmação.",
  },
  inquiry_without_response: {
    action: "follow_up_customer",
    reason: "Cliente falou e ficou sem resposta — responder enquanto está quente.",
  },
  no_price: {
    action: "clarify_product",
    reason: "Linha sem preço resolvido — esclarecer o produto correto com o cliente.",
  },
  stalled_opportunity: {
    action: "follow_up_customer",
    reason: "Oportunidade com valor parou de evoluir — retomar com um ângulo concreto.",
  },
  dormant_customer: {
    action: "reactivate_customer",
    reason: "Cliente recorrente esfriou — win-back com a média do ticket dele.",
  },
  unresolved_open_state: {
    action: "follow_up_customer",
    reason: "Oportunidade aberta sem próximo passo — definir e executar.",
  },
};

/** Ação da NBA de um tipo de risco — determinística, com razão legível. */
export function nbaDoTipo(riskType: string): { action: AcaoNBA; reason: string } | null {
  return ACAO_POR_TIPO[riskType] ?? null;
}

/**
 * Ordena riscos abertos por prioridade EXPLICÁVEL:
 * severidade do tipo → deadline mais próxima → maior valor.
 * Os três critérios saem nos `reason` — nada de score escondido.
 */
export function priorizar(riscos: RiscoParaNBA[]): Array<RiscoParaNBA & { nba: NbaSelecionada }> {
  return riscos
    .map((r) => {
      const base = ACAO_POR_TIPO[r.risk_type];
      if (!base) return null;
      const rank = SEVERIDADE[r.risk_type] ?? 99;
      const motivos: string[] = [base.reason];
      if (r.deadline_at) motivos.push(`prazo ${r.deadline_at}`);
      if (r.estimated_value_cents !== null) {
        motivos.push(`valor estimado ${r.estimated_value_cents} centavos`);
      }
      return { ...r, nba: { action: base.action, reason: motivos.join(" · "), rank } };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => {
      if (a.nba.rank !== b.nba.rank) return a.nba.rank - b.nba.rank;
      const da = a.deadline_at ? Date.parse(a.deadline_at) : Infinity;
      const db = b.deadline_at ? Date.parse(b.deadline_at) : Infinity;
      if (da !== db) return da - db;
      return (b.estimated_value_cents ?? -1) - (a.estimated_value_cents ?? -1);
    });
}
