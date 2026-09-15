/**
 * Cron driver genérico do event_log — a peça prometida em dispatcher.ts.
 *
 * Seleciona SÓ event_types com handler registrado: tipos drenados por crons
 * dedicados (ex. ai_agent.dispatch_requested → agent-dispatcher) não têm
 * handler no registry e ficam intocados.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchEvent, getRegisteredHandlers, type EventRow } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";

const MAX_ATTEMPTS = 5;

/** Depois disto, um evento em `processing` é considerado órfão e volta à fila. */
const PROCESSING_STALE_MS = 10 * 60 * 1000;

export interface DrainSummary {
  /**
   * Os `skipped` COM motivo, para o resumo poder ser lido de fora do banco.
   *
   * Opcional de propósito: quem monta um `DrainSummary` literal (por exemplo
   * `tests/unit/event-log-drain-loop.test.ts`) não precisa mudar.
   */
  pulados?: string[];
  scanned: number;
  done: number;
  retried: number;
  failed: number;
  dead: number;
}

function backoffAt(attempts: number): string {
  // 1min, 2min, 4min, 8min... (2^n minutos)
  const minutes = Math.pow(2, attempts);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export async function drainEventLog(
  admin: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<DrainSummary> {
  const limit = opts.limit ?? 50;
  const summary: DrainSummary = {
    scanned: 0,
    done: 0,
    retried: 0,
    failed: 0,
    dead: 0,
    pulados: [],
  };

  const handledTypes = [...new Set(getRegisteredHandlers().flatMap((h) => h.events))];
  if (!handledTypes.length) return summary;

  const nowIso = new Date().toISOString();

  // ─── EVENTO PRESO EM `processing` VOLTA PARA A FILA ────────────────────────
  //
  // A linha é marcada `processing` ANTES de o handler rodar, e NADA no produto
  // a devolvia: um handler que não retorna — processo derrubado no meio, OOM,
  // ida a um serviço externo sem timeout — deixava o evento preso para SEMPRE.
  // Não é hipótese: foi medido nesta frente com o Redis do debounce apontando
  // para uma porta sem ninguém escutando. O evento ficou `processing`,
  // `attempts=0`, `consumed_by` vazio, e o material que a pessoa cadastrou
  // nunca foi preparado — sem erro em lugar nenhum, e sem uma segunda chance.
  //
  // `job_queue` tem reaper desde sempre; o `event_log` não tinha. É o
  // invariante 4 do Sistema Vivo (nenhuma demanda sem próximo passo) aplicado à
  // fila de eventos.
  //
  // A janela é generosa de propósito: o handler mais lento do registry é um
  // turno de agente, e reclamar cedo demais faria DOIS workers agirem sobre o
  // mesmo evento — trocar um evento parado por um efeito em dobro.
  //
  // `updated_at` é confiável como "quando alguém tocou esta linha": o trigger
  // `trg_event_log_touch` (BEFORE UPDATE) o reescreve em toda atualização, então
  // a linha carrega o instante do CLAIM enquanto o handler não volta.
  const limiteDePresos = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
  const { data: reclamados } = await admin
    .from("event_log")
    .update({ status: "pending", updated_at: nowIso })
    .eq("status", "processing")
    .lt("updated_at", limiteDePresos)
    .select("id");
  if (reclamados?.length) {
    logger.warn("[event-log.drain] eventos presos em processing devolvidos à fila", {
      quantidade: reclamados.length,
    });
  }

  const { data: rows, error } = await admin
    .from("event_log")
    // `created_at` viaja porque um consumidor não consegue distinguir "evento de
    // agora" de "evento de três dias parado em `pending`" sem ele — e o drain
    // leva 50 por tick sem janela de recência, então um backlog vira enxurrada
    // de efeitos com data errada no primeiro tick depois de um deploy.
    .select(
      "id, organization_id, event_type, entity_kind, entity_id, payload, metadata, consumed_by, attempts, created_at",
    )
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${nowIso}`)
    .in("event_type", handledTypes)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    logger.error("[event-log.drain] select failed", { error: error.message });

    return summary;
  }

  /**
   * Mortos DESTA rodada, para o aviso na Central (ver bloco após o laço).
   * A linha `dead` em si persiste com last_error, mas ninguém é pago por ler
   * tabela — o aviso é o que torna a morte visível (mesma doutrina do
   * `job_queue`, cujo `failJob` já abre item crítico, e do
   * `recover-stuck-messages`).
   */
  const mortosDaRodada: { organization_id: string; event_type: string; last_error: string; id: string }[] =
    [];

  for (const raw of rows ?? []) {
    const row = raw as unknown as EventRow;
    summary.scanned += 1;

    // Claim otimista — outra instância pode ter pego a mesma linha.
    const { data: claimed } = await admin
      .from("event_log")
      .update({ status: "processing", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id");
    if (!claimed?.length) continue;

    const results = await dispatchEvent(row);

    const okKeys = results
      .filter((r) => r.status === "ok" || r.status === "skipped")
      .map((r) => r.consumer_key);
    const consumedBy = [...new Set([...row.consumed_by, ...okKeys])];
    const retry = results.find((r) => r.status === "retry");
    const errors = results.filter((r) => r.status === "error");

    if (retry) {
      // Reagendamento benigno (ex. janela anti-ban): NÃO conta attempt — mesmo
      // que outro handler do mesmo tick tenha retornado erro (esse handler
      // nunca entrou em consumed_by, então ele reroda no próximo tick; aqui só
      // preservamos o last_error dele pra visibilidade/observabilidade).
      // retry_at é opcional no HandlerResult — sem ele, aplica o mesmo backoff
      // do branch de erro pra não busy-loop reprocessando a cada tick.
      const retryAt = retry.retry_at ?? backoffAt(row.attempts + 1);
      await admin
        .from("event_log")
        .update({
          status: "pending",
          consumed_by: consumedBy,
          next_attempt_at: retryAt,
          updated_at: new Date().toISOString(),
          ...(errors.length
            ? {
                last_error: errors
                  .map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`)
                  .join("; "),
              }
            : {}),
        })
        .eq("id", row.id);
      summary.retried += 1;
    } else if (errors.length) {
      const attempts = row.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await admin
        .from("event_log")
        .update({
          status: dead ? "dead" : "pending",
          attempts,
          consumed_by: consumedBy,
          last_error: errors.map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`).join("; "),
          next_attempt_at: dead ? null : backoffAt(attempts),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      summary[dead ? "dead" : "failed"] += 1;
      if (dead) {
        mortosDaRodada.push({
          organization_id: row.organization_id,
          event_type: row.event_type,
          last_error: errors.map((e) => `${e.consumer_key}: ${e.detail ?? "error"}`).join("; "),
          id: row.id,
        });
      }
    } else {
      // O MOTIVO DE UM `skipped` SOBREVIVE À LINHA.
      //
      // `skipped` conta como sucesso — e deve mesmo: o handler decidiu que não
      // era caso dele. Mas o `detail` era DESCARTADO por construção, e com ele
      // a única evidência de por que um evento não fez nada. Quem investigasse
      // "subi o material e não aconteceu nada" encontrava uma linha `done` sem
      // uma palavra de explicação.
      //
      // Não muda o desfecho do evento; só deixa de jogar fora a resposta.
      const pulados = results.filter((r) => r.status === "skipped" && r.detail);
      // E o motivo sai também no RESUMO, não só na linha.
      //
      // A linha basta para quem tem psql; não basta para o CI, onde o único
      // artefato que sobrevive ao job é o trace — e o trace guarda o CORPO da
      // resposta HTTP. Um e2e que morre porque o gatilho pulou ficava sem poder
      // dizer QUAL pulo foi: travou por horas o diagnóstico de
      // `gatilho-de-etapa.spec.ts`, com `failed=0` e nenhuma pista.
      if (pulados.length)
        summary.pulados?.push(
          ...pulados.map((r) => `${row.event_type}/${r.consumer_key}: ${r.detail}`),
        );
      await admin
        .from("event_log")
        .update({
          status: "done",
          consumed_by: consumedBy,
          updated_at: new Date().toISOString(),
          ...(pulados.length
            ? { last_error: pulados.map((r) => `${r.consumer_key}: ${r.detail}`).join("; ") }
            : {}),
        })
        .eq("id", row.id);
      summary.done += 1;
    }
  }

  // ─── EVENTO MORRE AVISANDO, NÃO EM SILÊNCIO ─────────────────────────────────
  //
  // Antes deste bloco, `status='dead'` era um terminal MUDO: a linha ficava no
  // banco com last_error, o índice parcial `event_log_dead_idx` a listava, e
  // NENHUM sinal chegava a quem opera — ao contrário do `job_queue`, cujo
  // `failJob` abre item crítico na Central na mesma instrução. O contraste é o
  // próprio bug: a fila do agente acorda alguém, a fila genérica não. O
  // `event_dead` já estava no CHECK do `agent_inbox_items` desde a criação da
  // tabela (baseline:6457) — o vocabulário existia, o emissor é que faltava.
  //
  // Um item POR ORGANIZAÇÃO por rodada (e não por evento): um backlog morrendo
  // em lote não pode transformar a Central em spam — o corpo lista os tipos e o
  // primeiro last_error. Falha de write no aviso é logada e NÃO derruba o
  // drain (o desfecho dos eventos já foi persistido; o aviso é best-effort,
  // como o `audit()`).
  if (mortosDaRodada.length) {
    const porOrg = new Map<string, typeof mortosDaRodada>();
    for (const morto of mortosDaRodada) {
      const lista = porOrg.get(morto.organization_id) ?? [];
      lista.push(morto);
      porOrg.set(morto.organization_id, lista);
    }
    for (const [organization_id, mortos] of porOrg) {
      const tipos = [...new Set(mortos.map((m) => m.event_type))].sort();
      const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
        organization_id,
        kind: "event_dead",
        severity: "critical",
        title:
          mortos.length === 1
            ? "Um evento falhou em definitivo"
            : `${mortos.length} eventos falharam em definitivo`,
        body:
          `Tipos: ${tipos.join(", ")}. Após ${MAX_ATTEMPTS} tentativas com erro, ` +
          `os eventos foram marcados como dead e NÃO serão reprocessados — ` +
          `o efeito depende de nova ocorrência ou de ação manual. ` +
          `Último erro: ${mortos[0]!.last_error.slice(0, 400)}`,
        ref_kind: "event_log",
        ref_id: mortos[0]!.id,
      });
      if (inboxErr) {
        logger.error("[event-log.drain] aviso de evento dead na Central falhou", {
          error: inboxErr.message,
          organization_id,
        });
      }
    }
  }

  return summary;
}
