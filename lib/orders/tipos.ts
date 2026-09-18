import { z } from "zod";

/**
 * TIPOS E DECISÕES PURAS DO ORDER ENGINE (Fase 4, D3) — sem banco, sem IA.
 *
 * A máquina de estados (doc 25): draft → confirmed → (fulfilled → delivered →
 * closed, Fase 7/ERP) ; cancelled terminal a partir de draft|confirmed.
 * Rascunho é EDITÁVEL e mostra preço VIVO; confirmado é IMUTÁVEL (emenda é
 * evento — doc 14 invariante 3; implementação de emenda de confirmado: F7).
 */

export const STATUS_NATIVOS = ["draft", "confirmed", "cancelled"] as const;
export type StatusNativo = (typeof STATUS_NATIVOS)[number];

/** Vocabulário do log de domínio — tem CHECK no banco (0241). */
export const KINDS_DO_PEDIDO = ["created", "edited", "confirmed", "cancelled"] as const;
export type KindDoPedido = (typeof KINDS_DO_PEDIDO)[number];

/** Ator do evento — CHECK no banco. IA REGISTRA, nunca decide (doc 25 B1). */
export const ATORES_DO_PEDIDO = ["user", "ai", "system"] as const;
export type AtorDoPedido = (typeof ATORES_DO_PEDIDO)[number];

/**
 * Uma linha de rascunho como a API a recebe (produto + quantidade). O PREÇO
 * NUNCA vem daqui: o resolver resolve no servidor (doc 24 — a IA que montar
 * o rascunho via tool manda só produto/quantidade).
 */
export const linhaPedidoSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(100_000),
});
export type LinhaPedido = z.infer<typeof linhaPedidoSchema>;

export const pedidoCreateSchema = z.object({
  account_id: z.string().uuid(),
  items: z.array(linhaPedidoSchema).min(1).max(200),
});
export type PedidoCreate = z.infer<typeof pedidoCreateSchema>;

export const pedidoPatchSchema = z.object({
  items: z.array(linhaPedidoSchema).min(1).max(200),
});
export type PedidoPatch = z.infer<typeof pedidoPatchSchema>;

export const pedidoCancelSchema = z.object({
  motivo: z.string().trim().min(1).max(500),
});

/**
 * Transição válida de estado (pura). `null` = inválida, com motivo.
 * Rascunho edita; confirmado só cancela (emenda de confirmado: F7).
 */
export function transicaoValida(de: string, para: string): string | null {
  if (de === para) return "estado idêntico";
  if (de === "draft" && para === "confirmed") return null;
  if (de === "draft" && para === "cancelled") return null;
  if (de === "confirmed" && para === "cancelled") return null;
  return `transição ${de} → ${para} não existe`;
}

/**
 * Total do pedido = Σ(unitário × quantidade) — DIRC: CALCULADO, nunca
 * armazenado como verdade independente (doc 14 invariante 2).
 */
export function totalDasLinhas(
  linhas: Array<{ unit_price_cents: number; quantity: number }>,
): number {
  return linhas.reduce((acc, l) => acc + l.unit_price_cents * l.quantity, 0);
}

/**
 * Número externo do pedido nativo (B2): legível, único por construção, sem
 * corrida (sem contagem). `PED-2026-` + 12 hex do uuid. Sequência por org é
 * upgrade futuro (doc 25 B2).
 */
export function numeroExternoNativo(agora: Date, uuid: string): string {
  const ano = agora.getUTCFullYear();
  return `PED-${ano}-${uuid.replace(/-/g, "").slice(0, 12)}`;
}

/**
 * GATILHO DETERMINÍSTICO DE ESCALAÇÃO (doc 25 B1 / Fase 5 — "handoff quando
 * exigido"): classifica a recusa de um pedido rascunho em recuperável na
 * conversa ou digno de humano.
 *
 *  - `conta_inexistente`  → ESCALA: problema de IDENTIDADE (o vínculo
 *    contato↔conta não existe ou a conta sumiu) — nenhuma frase do agente
 *    conserta; resolve gente (0239) ou operador.
 *  - `moeda_mista`        → ESCALA: exceção de PRECIFICAÇÃO (linhas em moedas
 *    diferentes) — política comercial, não conversa.
 *  - `produto_inexistente`/`produto_inativo` → NÃO escala: o agente diz que
 *    não tem/oferta alternativa via `crm_search_products` (com o aviso de
 *    empate/relaxamento) e segue a conversa.
 *
 * A IA lê o flag; ela NÃO decide quando escala — o flag é determinístico e
 * testado aqui. Quem EXECUTA a transferência continua sendo o caminho nativo
 * `request_human_handoff` (BLOCKED_TOOL_IDS garante isso).
 */
export function classificarRecusaDePedido(motivo: string): { escalar_para_humano: boolean } {
  return { escalar_para_humano: motivo === "conta_inexistente" || motivo === "moeda_mista" };
}
