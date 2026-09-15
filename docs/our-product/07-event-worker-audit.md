---
type: our-product/phase-0-audit
doc: 07-event-worker-audit
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d
evidence: lib/event-log/, lib/agent-engine/queue/, lib/agent-engine/edge/crm/drain.ts, app/api/v1/cron/
---

# 07 — Auditoria de eventos / workers / confiabilidade

## 1. Os dois barramentos (CONFIRMADO)

**`event_log`** (outbox): colunas id/org/event_type (CHECK regex `a.b`)/entity/payload/metadata/**consumed_by text[]**/attempts/next_attempt_at/status (pending|processing|done|dead). Emissores no **mesmo commit** do negócio: triggers SQL (`messages`→message.*, `crm_leads`→lead.won/lost/reopened/assigned, `conversations`→routing_requested com unique parcial anti-duplicação, sessões/casos/agenda) + RPC `emit_event` (SECURITY DEFINER que valida membership e carimba origem) + app code (a ingest emite dispatch; **várias rotas admin emitem fire-and-forget `void insert`** — janela de perda).

**`job_queue`** (fila durável do agent-engine): kind/status/attempts/locked_by/run_after, unique parcial **1-running-por-contato**, unique (org, source_event_id) — o event→job nunca duplica. Claim com `pg_advisory_xact_lock` + `FOR UPDATE SKIP LOCKED`; retry backoff exponencial cap 120s; **dead → alerta crítico na Central**; reaper de visibilidade revive órfãos; `completeJob(inSameCommit)` = **exactly-once de efeito** (a emissão do próximo evento pode entrar no mesmo commit da conclusão; perda de lease aborta o commit inteiro).

## 2. Drain e handlers (CONFIRMADO)

- Drain genérico (cron 1 min, 50/tick, FIFO por created_at): claim por **CAS condicional** (`update ... where status='pending'` — correto, não atômico sob alta contenção; SEM SKIP LOCKED), reaper de órfãos 10 min (nasceu de incidente real de Redis), backoff 2^n min, **5 tentativas → dead silencioso** (sem alerta; contrasta com job_queue). Dedup por consumidor: `consumer_key` em `consumed_by`.
- Registry (`register-handlers.ts`): ~15 consumidores estáveis (aiResponse, aiSentiment, ragIndexer, lgpd export/redact, automationRules, followup reactivity/gatilho-etapa/caso/presença, media persist/derive, webPush, conversões de venda — registradas por ÚLTIMO de propósito). Tipos dedicados (dispatch_requested, routing_requested) têm drainers próprios com SKIP LOCKED real.
- Ordenação: FIFO-por-tick apenas; sem garantia entre tipos/entidade — consumidores se defendem (dispatch re-checa recência do inbound; doc 07 do agente).

## 3. Crons (22 rotas, `scheduler` crond → curl com Bearer)

1 min: event-log-drain, followup-flow-worker, routing-worker, recover-stuck-messages (+agent-dispatcher no-op legado). 5-15 min: storage-redaction, snooze-watcher, attendant-heartbeat, webhook-log-retention, channel-health, agenda push/refresh/sync/reminder, contact-avatars/phones, risk-watcher. Diários: contact-proposals-watcher (1h), lgpd-sla-watcher, kb-conversations-batch, sync-model-catalog, data-retention. Gate no CI: toda rota de cron precisa de linha de crontab (`cron-routes-scheduled.test.ts`). **Em Vercel só 1 cron rota (Hobby)** — a liveness do barramento depende dos containers worker+scheduler.

## 4. Idempotência (CONFIRMADO)

- Camada de dados: unique (org, external_id) em messages/nuvemshop_products/orders(3-col)/leads(parcial)/webhook_events_log(parcial); DEFERRABLE no messages (echo out-of-band).
- Camada de fila: unique source_event; send_ledger unique (job_id, seq) — **intenção exactly-once, entrega at-least-once**, crash reconciliado pela idempotency_key na metadata da mensagem.
- Camada de API: `idempotency_keys` (org, key, endpoint, request_hash, TTL 24h no Postgres) — o client **auto-envia** o header em toda mutação, mas o servidor só o honra em **4 rotas** (tenants RPC, channel-sessions, lgpd approve, onboarding whatsapp session) + usos internos.

## 5. Corridas e recuperação (CONFIRMADO)

Primitivos em uso: advisory locks (727258 fila, 727257 migrate, playbook-seed), SKIP LOCKED (job_queue, dispatch drain, cron ticker por contato), CAS com claim-token (routing: `updated_at` como token), atomic claim por `.eq(status)` (recover-stuck), lease check no completeJob. Recuperação: reapers em 3 camadas (event 10min, dispatch por tick, routing 5min) + reaper de fila no boot + SIGTERM drain com graça. Stuck sends: falha visível + alerta, **nunca reenvio automático** (duplo é pior que silêncio — e `queued` tem dono, `sending` não).

## 6. Veredito para Event → queue → worker → ORDER creation → audit → notification

**A arquitetura aguenta pedidos — se o fluxo novo usar os primitivos certos.** O caminho de envio de mensagem já é order-grade (ledger + reconciliação + exactly-once de efeito). As brechas específicas para ORDER-grade:

1. **Não usar o drain genérico para dinheiro** — usar `job_queue`/drainer dedicado (SKIP LOCKED + dedup + dead-letter com alerta). RECOMENDAÇÃO.
2. **Outbox transacional no insert do pedido** — pedido + evento de domínio no mesmo commit (padrão trigger/RPC já provado; banir `void insert` fire-and-forget para fluxo de dinheiro).
3. **Idempotency-Key server-side** na rota de criação de pedido (a infra existe: tabela + padrão 23505→idempotente, provado em `fn_create_tenant_with_owner`).
4. **Saga/compensação para ERP sync** — nada no repo faz rollback de efeito externo (o mais próximo é `conversaoDeVenda` com retry). Pedir sync_ledger persistente (irmão do `send_ledger`) com estados e reconciliação + alerta de dead-letter.
5. **Reconciliar o buraco atual**: dead-letters de event_log silenciosas e eventos fire-and-forget são dívidas reais — corrigir na Fase 1 (barato, mesmo arquivo/padrão).
6. Redis permanece fora do caminho durável (efêmero por design) — nenhuma dependência nova.
