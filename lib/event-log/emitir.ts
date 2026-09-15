/**
 * Emissão de evento de domínio AGUARDADA — o oposto do `void ...insert()`.
 *
 * ─── O defeito que este helper fecha (Fase 0, docs/our-product/07 §10) ──────
 *
 * Seis pontos emitiam evento com `void admin.from("event_log").insert(...)`
 * (e alguns com `.then(({ error }) => console.error(...))`): não aguardavam,
 * não eram transacionais e não eram retentados. Um crash do processo, um erro
 * de rede no Supabase ou um deploy no meio da escrita PERDIA o evento — em
 * silêncio, porque não havia quem olhe para o resultado descartado. Em rotas
 * de admin isso é pior: `tenant.suspended` perdido deixa consumers sem saber
 * que a organização parou.
 *
 * ─── Por que `await` e não throw ─────────────────────────────────────────────
 *
 * O evento é emitido DEPOIS da mutação de negócio já bem-sucedida: falhar a
 * resposta agora mentiria para o cliente ("não resolveu" quando resolveu).
 * A política é a mesma do `audit()`: best-effort com visibilidade — aguarda
 * (o evento entra antes do `ok()`, então um deploy não o mata no meio) e, em
 * erro, loga com severidade alta. Quem precisa de garantia transacional de
 * verdade (mutação + evento no MESMO commit) usa trigger SQL/`emit_event()`,
 * como a doutrina manda — este helper é para os pontos onde o evento é
 * construído no app e a mutação já aconteceu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export interface EventoDeDominio {
  organization_id: string;
  event_type: string;
  entity_kind?: string;
  entity_id?: string | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export async function emitirEventoAguardado(
  admin: SupabaseClient,
  evento: EventoDeDominio,
): Promise<void> {
  const { error } = await admin.from("event_log").insert({
    organization_id: evento.organization_id,
    event_type: evento.event_type,
    ...(evento.entity_kind !== undefined ? { entity_kind: evento.entity_kind } : {}),
    ...(evento.entity_id !== undefined ? { entity_id: evento.entity_id } : {}),
    ...(evento.payload !== undefined ? { payload: evento.payload } : {}),
    ...(evento.metadata !== undefined ? { metadata: evento.metadata } : {}),
  });
  if (error) {
    logger.error("[event-log.emitir] evento de domínio NÃO foi gravado", {
      event_type: evento.event_type,
      organization_id: evento.organization_id,
      error: error.message,
    });
  }
}
