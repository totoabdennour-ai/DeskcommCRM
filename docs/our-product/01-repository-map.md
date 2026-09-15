---
type: our-product/phase-0-audit
doc: 01-repository-map
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d (branch phase-0-audit)
evidence: leitura direta de código por 7 varreduras de auditoria (read-only)
---

# 01 — Mapa completo do repositório

> Todo número abaixo foi **medido no commit `5c132f4d` (2026-09-14)** com comandos citados
> ao lado. O `AGENTS.md` afirma números de 2026-08-14 (ex.: "166 route handlers") — a base
> cresceu; os números daqui substituem os dele para efeito de planejamento.

## 0. Números de cabeçalho (CONFIRMADO)

| Métrica | Valor | Como medir |
|---|---|---|
| Route handlers (`app/api/**/route.ts`) | **270** | `find app/api -name route.ts \| wc -l` |
| … sob `/api/v1` | 268 | `find app/api/v1 -name route.ts \| wc -l` |
| … crons (`app/api/v1/cron/*`) | 22 | `ls app/api/v1/cron \| wc -l` |
| `/api/internal` | 1 (`agents/run`) | — |
| `/api/mcp` | 1 (Streamable HTTP) | — |
| Migrations SQL | **219** (+ `MANIFEST.md`) | `ls supabase/migrations/*.sql \| wc -l` |
| Tabelas (baseline.sql) | **~130** (135 ocorrências `CREATE TABLE`, incl. apêndice idempotente) | `grep -ci 'CREATE TABLE' supabase/baseline.sql` |
| Testes unitários em `tests/unit/` | **548** arquivos | `ls tests/unit/*.test.* \| wc -l` |
| Invariantes de banco (`tests/invariants/`) | **189** arquivos | `ls tests/invariants/*.test.ts \| wc -l` |
| Specs E2E Playwright | **103** | `ls tests/e2e/*.spec.ts \| wc -l` |
| Testes co-localizados (app/lib/components/workers) | ~238 | `git ls-files '*.test.ts(x)'` fora de `tests/` |
| Handlers que importam `createAdminClient` (service role) | **149 de 270** arquivos de rota | `grep -rl createAdminClient app/api --include='*.ts'` |
| `lib/database.types.ts` | 8.803 linhas (gerado) | `wc -l` |
| Maior arquivo escrito à mão | `lib/agent-engine/agent/inbound-turn.ts` — **4.083 linhas** | `wc -l` |

## 1. Layout de topo

| Diretório | Arquivos | Propósito |
|---|---|---|
| `app/` | ~722 | Next.js 16 App Router: UI autenticada (`app/app/`), admin de plataforma (`app/admin/`), públicas (`(public)`, `auth`, `team`), Server Actions (`app/actions/`), API REST (`app/api/`) |
| `components/` | ~205 | React por domínio: `inbox/`, `kanban/`, `contacts/`, `agenda/`, `ai/`, `shell/`, `ui/` (shadcn), `branding/`, `voice/` |
| `lib/` | ~858 | Toda a lógica de negócio — ~63 subdiretórios (ver §3) |
| `workers/` | 17 | Workers de longa duração + handlers de `event_log` |
| `supabase/` | 224 | `baseline.sql` (schema canônico do self-host), `migrations/`, `config.toml` |
| `tests/` | ~970 | `unit/`, `invariants/`, `e2e/`, `journeys/`, `api/`, `shell/`, scripts de prova |
| `scripts/` | 88 | Seeds E2E, `bootstrap-owner.ts`, `test-db.sh`, lint custom (`lint-channels.ts`, `lint-role-rank.ts`), release |
| `hostgator-setup-kit/` | 16 | Kit self-host: `install.sh`, `update.sh`, `backup.sh`, `restore.sh`, `healthcheck.sh`, `agent.sh` (atualização pela tela), `reset-password.sh`, `reset-mfa.sh` |
| `docs/` | ~230 | PRDs, specs, doutrina (`docs/doctrine/`), runbooks, ADRs, threat model |
| `.github/` | 13 | 7 workflows + action composta `preparar-node` |
| `hooks/`, `types/`, `public/` | — | Hooks React por domínio, tipos ambientes, `notify-sw.js` (web push), `llms.txt` |
| raiz | — | `proxy.ts` (middleware Next 16), `vercel.ts`, 3 Dockerfiles, 5 compose, `Caddyfile`, configs Sentry/Vitest/Playwright |

## 2. Superfície App Router

### 2.1 API REST (`app/api/v1/`, 268 handlers em 268 rotas)

Grupos por contagem de rotas:

- **IA/agentic**: `ai` (66 — agents, routers, knowledge, credentials, providers, runs, usage, skills, proposals, memory, pacing, followups, cases…), `automation-rules` (5), `webhook-sources` (3), `lead-captures` (1)
- **CRM**: `leads` (13), `contacts` (10), `conversations` (19), `pipelines` (7), `messages` (2), `message-templates` (2), `demandas` (1), `agenda` (16), `tasks` (2)
- **Canais**: `channels` (5), `channel-sessions` (5), `webhooks` (9 — waha global + `[token]`, meta `[token]`, nuvemshop `[event]` + 3 LGPD, `in/[token]`, `channel/[token]` neutro), `voice` (11), `attendants` (2), `ads` (2)
- **Plataforma/admin**: `admin` (21), `team` (11), `settings` (4), `system` (5), `audit` (2), `metrics` (2), `reports` (1), `notifications` (1), `onboarding` (2), `auth` (3), `lgpd` (5), `integrations` (1), `marca` (1), `health` (1), `mcp` (1)
- **Cron**: 22 rotas (`app/api/v1/cron/`, Bearer `INTERNAL_CRON_SECRET`, agendadas pelo serviço `scheduler`)

### 2.2 UI autenticada (`app/app/`)

Inbox, Radar, Kanban, Contatos, Leads, Funis (`pipelines`), Atividades, Tarefas, Agenda, Produtos (`products`), Webhooks/Automações, Conexões, Integrações/Nuvemshop, `ai/{agents,routers,knowledge,credentials,providers,runs,usage,skills,proposals,memory,cases,followups,inbox}`, Métricas (`metrics`, `analise`), Audit Log, LGPD, Equipe, Configurações (`api-tokens`, `atendimento`, `atualizacao`, `billing`, `canal-oficial`, `conversoes`, `marca`, `meta-ads`, `notifications`, `profile`, `security`, `templates`, `tenant`).

### 2.3 Admin de plataforma (`app/admin/`)

`(protected)/{dashboard, tenants, users, platform-admins, incidents, audit, usage, lgpd, marca, google, inbox}` + `forbidden`.

### 2.4 Server Actions (`app/actions/`, 41 arquivos)

`auth/` (sign-in/up/out, MFA, recovery), `onboarding/` (finish, createDefaultAgent, montarQuadro, chaveDaIa, aceitar welcome), `settings/` (perfil, tenant, branding, marca da org, notificações, pipeline config, Google OAuth, conexões de anúncios, idioma, `signOutEverywhere`, `regenerateRecoveryCodes`, `apagarDadosOperacionaisDaOrganizacao`), `team/acceptInvite`, `integrations/{connect,disconnect}Nuvemshop`, `shell/` (org ativa, sidebar).

## 3. `lib/` — os módulos que importam

| Módulo | O que é | Arquivos-chave |
|---|---|---|
| `lib/agent-engine/` | Runtime do agente de IA (worker 24/7): turnos, guardrails, fila, pacing, flywheel | `agent/inbound-turn.ts` (4.083 l.), `agent/{operator-turn,followup-turn}.ts`, `guardrails/before-send.ts` (1.238 l.), `edge/llm/run-model-call.ts` (673 l.), `queue/queue.ts`, `edge/crm/drain.ts`, `pacing/engine.ts` |
| `lib/ai/` | Plataforma IA compartilhada: gateway/providers, pontos de IA, embeddings, RAG, budget, handoff, uso | `pontos/registro.ts` (23 pontos), `gateway.ts`, `embed.ts`, `budget/check.ts`, `handoff/orchestrator.ts` |
| `lib/mcp/` | Servidor MCP (60 tools) + auth de token + audit | `server.ts`, `auth.ts`, `tools/catalogo/*.ts` (9 domínios), `audit.ts` |
| `lib/channels/` | Abstração de canais: adapters (waha, meta_cloud, zernio), capabilities, inbound neutro | `types.ts`, `capabilities.ts`, `adapters/*.ts`, `pos-entrada.ts`, `meta/*` |
| `lib/waha/` | Ingest WAHA (HMAC SHA-512, normalização, echo/fromMe) + cliente HTTP | `ingest.ts` (1.089 l.), `client.ts` (661 l.), `webhook-auth.ts` |
| `lib/event-log/` | Barramento: registro de handlers, drain genérico | `register-handlers.ts`, `dispatcher.ts`, `drain.ts`, `drain-loop.ts` |
| `lib/followup/` | Motor de follow-up (63 arq.): engine adaptativo, gatilhos por etapa | `engine.ts` (877 l.), `graph-schema.ts` |
| `lib/automation/` | Regras QUANDO/SE/ENTÃO + webhooks de saída com SSRF guard | `engine.ts`, `actions/*` (7 executoras), `outbound-url.ts`, `outbound-ip.ts` |
| `lib/leads/`, `lib/contacts/`, `lib/kanban/`, `lib/pipelines/` | CRM core | `nascimento-do-lead.ts`, `activity-vocabulary.ts`, `escopo-de-funil.ts`, `vocabulary.ts`, `cpf.ts`, `duplicados.ts` |
| `lib/auth/` | Sessão, RBAC, rate limit de auth, convites, public paths | `server.ts` (`loadAuthUser`, `resolveActiveOrg`), `require-role.ts`, `rate-limit.ts`, `invite-token.ts`, `public-paths.ts` |
| `lib/lgpd/` | Export/redact/anonimização, consentimento, SLA, assinatura PAdES | `export-collector.ts` (842 l.), `cascata.ts`, `redact-cascade.ts`, `pades-signer.ts` |
| `lib/routing/` | Roteamento de atendimento (fila, rodízio, elegibilidade, políticas por canal) | `decide.ts`, `worker.ts`, `channel-policies.ts` |
| `lib/catalogo/` | Catálogo de produtos (busca por token, importador CSV) | `busca.ts`, `planilha.ts` |
| `lib/nuvemshop/` | OAuth + webhooks Nuvemshop (sem sync de pedido/produto) | `oauth.ts`, `api-client.ts` |
| `lib/conversoes/` | Conversões off-line → Meta CAPI (Purchase com `value_cents` do lead) | `envio.handler.ts` |
| `lib/agenda/` | Agendamento + Google Calendar bidirecional | `consulta.ts` (709 l.), `google/*` |
| `lib/branding/` | White-label (resolvidores que nunca lançam) | `instalacao.ts`, `saida.ts`, `css.ts`, `logo-arquivo.ts` |
| `lib/supabase/` | Clients canônicos | `browser.ts`, `server.ts`, `admin.ts` |
| `lib/api/` | Contrato REST | `wrappers.ts` (`ok()`/`fail()`), `errors.ts`, `client.ts` |
| `lib/navigation/` | Registro central de telas (gate de completude no CI) | `catalogo.ts` (677 l.), `registry.ts` |
| `lib/sentry/` | Scrub de PII único (server/edge/client) | `scrub.ts`, `dsn.ts` |
| `lib/voice/`, `lib/wacalls/` | Chamadas de voz WhatsApp (opt-in duplo) | `opt-in.ts`, `guarda.ts`, `session.ts`, `events-bridge.ts` |

Padrão estrutural: lógica pesada em `_handler.ts`/`_client.tsx` co-localizados junto a `route.ts`/`page.tsx` finos.

## 4. Workers (`workers/`)

| Worker | Consome | Efeito |
|---|---|---|
| `agent-worker/main.ts` | `job_queue` + `event_log` + crons internos | **Processo 24/7**: turnos de IA (`inbound_turn`, `followup_turn`, `operator_turn`, `case_reply_turn`, `approved_reply`, `transactional_delivery`), drain de dispatch, watchdog de sessão, circuito de saúde, flywheel, ponte de voz. Boot ritual: Zod → schema check (migração 0050) → reaper de órfãos → `/healthz` + `/metrics` |
| `ai-response-worker.ts` (+handler) | `message.received` | Resposta IA (caminho legado paralelo ao agent-engine) |
| `ai-sentiment-worker.ts` (+handler) | `message.received` | `generateObject` com Zod (único do repo); <0.3 → `ai.sentiment_alert` |
| `ai-handoff-from-sentiment.handler.ts` | `ai.sentiment_alert` | Handoff IA→humano (gate G2) |
| `rag-indexer.ts` (+handler) | `nuvemshop.product_synced`, `knowledge_source.updated` | Chunking → embedding 1536d → `ai_chunks` |
| `lgpd-export-worker.ts` / `lgpd-redact-worker.ts` | `lgpd.*` | Export bundle + anonimização em cascata |
| `media-persist-worker.ts` / `media-derive-worker.ts` | `media.*` | Mídia → Storage; derivação (Whisper/vision/PDF/ffmpeg) → `messages.media_derived_text` |
| `storage-cleanup-worker.ts` | — | Poda de storage |

## 5. Crons (22 rotas; agendadas no `docker/scheduler/entrypoint.sh`)

A cada 1 min: `event-log-drain`, `followup-flow-worker`, `routing-worker`, `recover-stuck-messages` (o `agent-dispatcher` é no-op legado mantido para crons de self-host antigos). A cada 5 min: `storage-redaction`, `snooze-watcher`, `attendant-heartbeat`, `webhook-log-retention`, `channel-health`, `agenda-google-push`, `agenda-reminder`. A cada 10-15 min: `contact-avatars`, `contact-phones`, `agenda-google-refresh/sync`, `risk-watcher`. Diários: `contact-proposals-watcher` (horário), `lgpd-sla-watcher` (12h), `kb-conversations-batch` (03:30), `sync-model-catalog` (04:15), `data-retention` (04:40). Gate: `tests/unit/cron-routes-scheduled.test.ts` reprova rota de cron sem linha de crontab.

**Dependência de modo de deploy**: `vercel.ts` agenda só `lgpd-sla-watcher` (limite do plano Hobby) — em Vercel, os eventos ficam pendentes indefinidamente. VPS (kit) é o modo operacional pleno.

## 6. Docker / packaging

`docker-compose.prod.yml`: `app` (imagem GHCR `stable`), `worker` (agent-engine), `scheduler` (crond→curl nos crons), `waha` (`devlikeapro/waha:latest-2026.7.2`, NOWEB), `redis` (efêmero), `srh` (serverless-redis-http, Upstash-REST compatível, pin por digest), `wacalls` (voz, opt-in), `caddy` (TLS). Composes variantes: `.npm.yml` (Nginx Proxy Manager), `.traefik.yml` (labels p/ proxies de hospedagem), `.build.yml` (build local), `.yml` (dev: WAHA+worker). Doutrina: nenhum serviço constrói na máquina do cliente; publicação é ato do CI (`publish-image.yml`, job `imagens-ok` obrigatório).

## 7. Config

- `lib/env.ts` (429 l.): Zod no boot. Sempre obrigatórias: Supabase trio. Obrigatórias em prod: `INTERNAL_SECRET`, `CPF_ENCRYPTION_KEY`, `WAHA_BYO_ENCRYPTION_KEY`, `AI_CRED_AES_KEY`, `SUPABASE_DB_URL` (chave DDL vigiada por teste — o app não pode usá-la), Upstash, trio WAHA. Grupos: retenção, criptografia, WAHA, WaCalls, IA (gateway/OpenRouter/Anthropic/OpenAI, budget, dispatcher), Sentry, Resend, `IMPERSONATE_COOKIE_SECRET`, LGPD, Google Calendar, Nuvemshop, white-label (`APP_NAME/APP_LOGO_URL/APP_ACCENT_HEX` injetados por `PublicEnvScript`), web push VAPID.
- `.env.example`: 88 chaves (superset, com Meta Cloud API, Zernio BSP, knobs de fila) — sincronizado por `tests/unit/env-example-sync.test.ts`.
- `next.config.ts`: `output: standalone` (self-host), `typedRoutes`, security headers (nosniff, DENY, Referrer-Policy, Permissions-Policy) — **sem CSP e sem HSTS**.

## 8. CI/CD (`.github/workflows/`)

| Workflow | Jobs | Conteúdo |
|---|---|---|
| `ci.yml` | `verify`, `invariants` | typecheck + lint + `lint:channels` + `lint:role-rank` + `test:unit` + `test:shell`; `test:db` (Postgres efêmero pg15 + baseline install/update + invariantes) |
| `e2e.yml` | `e2e` | Supabase local + baseline + Playwright (todas as specs menos `FORA_DO_CI`; a P0 `vps-fresh-onboarding` segue fora) |
| `perf.yml` | `build-and-size` | `pnpm build` + orçamento de tamanho |
| `publish-image.yml` | `imagens-ok` + publish | Build/push GHCR + smoke test da imagem + promoção `stable` |
| `release.yml` | release PR + tag | Fragmentos `.changes/` → CHANGELOG |
| `relogio.yml`, `acolhida.yml` | tick / greeting | Agendado / saudação de PR sem checkout |

**Os cinco checks obrigatórios** (branch protection): `verify`, `build-and-size`, `invariants`, `e2e`, `imagens-ok`.

## 9. Artefatos n8n

**Ausentes.** Zero arquivos, dependências ou workflows n8n no repositório. n8n aparece só como *consumidor suportado por generalidade* dos webhooks de captação (`lib/webhooks/rdstation.ts:17`, `lib/automation/outbound-url.ts:6`) e como alvo de automação de saída. CONFIRMADO: o protótipo n8n do dono do produto não vive neste repo (ver doc 11).

## 10. Mapa por subsistema (formato do pedido)

| Subsistema | Entry point | Tabelas principais | API principal | Serviços externos | Jobs | Cobertura de teste | Segurança | Limitações |
|---|---|---|---|---|---|---|---|---|
| **Plataforma/auth/tenancy** | `app/(public)`, `app/actions/auth/`, `proxy.ts` | `organizations`, `user_organizations`, `platform_admins`, `team_invites`, `user_recovery_codes` | `team`, `settings`, `admin`, `onboarding` | Supabase Auth | — | unit + invariantes G1/Gov + e2e auth | getUser, MFA opcional por política, suporte/impersonation com AAL2 | Sem SSO/SAML; roles fixos 4+ai_operator |
| **CRM (leads/funil)** | `app/app/kanban`, `lib/leads/` | `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`, `crm_tasks` | `leads` (13), `pipelines` (7) | — | lead.* events → automação | invariantes escopo de funil + e2e kanban | RLS + requireRole + `escopo-de-funil` | value_cents só no lead; sem pedido nativo |
| **Conversas/inbox** | `app/app/inbox`, `lib/inbox/` | `conversations`, `messages`, `conversation_notes`, `agent_inbox_items` | `conversations` (19), `messages` | Supabase Realtime | push handler | e2e inbox tempo real (fora do CI 1 spec) | RLS; visibilidade por papel | `conversations.channel` CHECK só 'whatsapp' |
| **Canais/WhatsApp** | `lib/waha/ingest.ts`, `lib/channels/` | `channel_sessions`, `channel_knobs`, `pacing_ledger`, `meta_templates` | `webhooks/*`, `channels`, `channel-sessions` | WAHA, Meta Graph, Zernio, WACALLS | channel-health, recover-stuck | unit ingest + e2e webhooks + lint-channels | HMAC SHA-512/256 timing-safe; fail-closed | Instagram/Messenger inexistentes |
| **Agente de IA** | `workers/agent-worker`, `lib/agent-engine/` | `job_queue`, `send_ledger`, `lead_checkpoints`, `ai_agents(+versions)`, `llm_calls`, `before_send_traces` | `ai/*` (66), MCP interno | LLM via BYOK (Anthropic/OpenAI/Google/OpenRouter) | loops do worker | golden candidates + unit massivo + e2e capacidades | guardrails before-send v6; budget; efêmero token | inbound-turn 4.083 l. (hot spot) |
| **RAG/conhecimento** | `workers/rag-indexer` | `ai_knowledge_sources/versions`, `ai_chunks` (vector 1536, ivfflat) | `ai/knowledge`, MCP `crm_search_knowledge` | OpenAI embeddings | kb-conversations-batch | invariantes `rag-acervo-da-organizacao` | org-scoped RPCs | embedding só OpenAI (key ladder); extração PDF/MD apenas |
| **MCP** | `app/api/mcp/route.ts` | `api_tokens`, `api_audit_log` | 60 tools | — | — | invariantes `mcp-nao-alcanca-outro-tenant` | Bearer hash SHA-256, scopes, BLOCKED_TOOL_IDS | Sem MCP público/ecossistema |
| **Automações/webhooks** | `lib/automation/`, `app/app/webhooks` | `automation_rules/runs`, `webhook_sources`, `webhook_events_log`, `webhook_lead_captures` | `automation-rules`, `webhook-sources`, `webhooks/in/[token]` | qualquer webhook de saída (SSRF guard) | drain em-request (kickLocalPipeline) | invariantes + e2e | rate limit 60/min/token; HMAC opcional | 7 ações; nenhuma de comércio |
| **Agenda** | `lib/agenda/` | `calendar_*` (7 tabelas) | `agenda` (16) | Google Calendar | push/refresh/sync/reminders | invariantes agenda-MCP | RPCs com RBAC+MFA | Google apenas |
| **LGPD** | `lib/lgpd/`, `app/app/lgpd` | `lgpd_requests`, `storage_redaction_queue`, `contacts.consent` | `lgpd` (5) | Resend (e-mail) | export/redact workers + SLA + storage-redaction | unit + e2e | anonimização irreversível; PAdES | cpf_hash sem salt (ver doc 08) |
| **Eventos/workers** | `lib/event-log/`, `job_queue` | `event_log`, `job_queue`, `send_ledger` | crons | Redis (efêmero, best-effort) | todos | invariantes + testes de fila | Bearer fail-closed | dead-letter de event_log silencioso |
| **Comércio (hoje)** | `lib/catalogo/`, `lib/nuvemshop/` | `catalog_products`, `orders`, `nuvemshop_products`, `tenant_integrations` | `products` (3), `integrations` | Nuvemshop (webhooks only) | — (sync inexistente) | unit busca/import | RLS; moeda da org | orders sem escritor; sem order_items |
| **Self-host kit** | `hostgator-setup-kit/` | baseline.sql | — | Docker | agent.sh (5 min) | `tests/shell` (test:shell) | segredos gerados | sem ensaio automatizado de update em VPS real |
