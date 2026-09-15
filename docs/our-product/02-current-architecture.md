---
type: our-product/phase-0-audit
doc: 02-current-architecture
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d
---

# 02 — Arquitetura atual (como o sistema realmente funciona)

## 1. Visão de camadas (CONFIRMADO em código)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                  │
│  Next.js 16 App Router · React 19 · Server Components por default       │
│  Realtime (postgres_changes + broadcast) como OTIMIZAÇÃO, não verdade   │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ cookie sb-deskcomm-auth (SameSite=Strict)
┌──────────────▼───────────────────────────────────────────────────────────┐
│ APP Next.js (container `app`, output standalone)                         │
│  proxy.ts (borda): X-Request-Id · refresh de sessão · impersonation edge │
│  app/api/v1/**  (268 rotas REST, ok()/fail(), requireRole 241 usos)     │
│  app/api/internal (1) · app/api/mcp (1, 60 tools) · app/api/v1/cron (22)│
│  app/actions/** (41 Server Actions)                                     │
└──────┬───────────────────────┬──────────────────────────┬────────────────┘
       │ supabase-js (RLS)     │ service role (149 rotas) │ adapters
┌──────▼──────────┐   ┌────────▼─────────┐   ┌────────────▼───────────────┐
│ SUPABASE        │   │ WORKER 24/7      │   │ CANAIS                     │
│ Postgres+RLS    │   │ (agent-engine)   │   │ WAHA NOWEB (QR)            │
│ Auth (GoTrue)   │   │ job_queue        │   │ Meta Cloud API (templates) │
│ Realtime        │   │ event_log drain  │   │ Zernio BSP                 │
│ Storage (5 buckets, 1 público)│ guardrails│  │ WACALLS (voz, opt-in)    │
└──────┬──────────┘   └────────┬─────────┘   └────────────────────────────┘
       │                       │ runModelCall (BYOK)      ▲
┌──────▼──────────┐   ┌────────▼─────────┐   ┌────────────┴───────────────┐
│ SCHEDULER (cron)│   │ LLM PROVIDERS    │   │ REDIS (efêmero) + SRH      │
│ crond → curl    │   │ Anthropic/OpenAI │   │ rate limit + debounce      │
│ → /api/v1/cron  │   │ /Google/OpenRtr  │   │ (fallback in-memory)       │
└─────────────────┘   └──────────────────┘   └────────────────────────────┘
```

## 2. O fluxo canônico de uma requisição de tenant (CONFIRMADO)

`proxy.ts` → handler: **1)** Zod valida input externo → **2)** guard (`requireRole` — papel resolvido do **banco** via `fn_user_role_in_org`, nunca do cookie; `requirePlatformAdmin`; secret/HMAC nas superfícies não-cookie) → **3)** `resolveActiveOrg()` — org de fonte confiável (cookie validado contra memberships, token de webhook, path token, bearer hash; **nunca do body**) → **4)** query (client de sessão com RLS, ou service role com filtro manual de `organization_id`) → **5)** `audit()` fire-and-forget se mutação → **6)** `ok()`/`fail()` com envelope `{data, meta?}` / `{error:{code,message}}`.

Superfícies não-cookie: `/api/v1/cron/*` (Bearer `INTERNAL_CRON_SECRET`, fail-closed), `/api/internal/*` (`x-internal-secret`), `/api/mcp` (Bearer `dsk_` → hash SHA-256 em `api_tokens`, scopes), `/api/v1/webhooks/*` (HMAC WAHA SHA-512 por sessão / Meta SHA-256 / Nuvemshop SHA-256 / captação por path token + HMAC opcional).

## 3. O turno do agente (o coração do produto — CONFIRMADO, `lib/agent-engine/`)

Inbound WhatsApp → webhook (HMAC) → RPCs atômicos de identidade (`fn_upsert_wa_contact/conversation`) → `pos-entrada` (opt-out → lead → elegibilidade IA) → `emit_event('ai_agent.dispatch_requested')` → **worker 24/7** drena para `job_queue` (dedup `uniq_job_queue_source_event`, SKIP LOCKED, uma corrida por contato) → `runAgentTurn` (inbound-turn.ts):

1. Budget-escort (`comHandoffSeOrcamentoAcabar`) envolve o turno inteiro.
2. Elegibilidade, opt-out, janela 7-22h (pacing pode re-agendar o job).
3. Resolução do agente (roteador de intenção LLM ou binding por canal) → persistida em `ai_router_decisions`.
4. Contexto: playbook versionado (plataforma→tenant→campanha) + memória da org + skills + checkpoint do lead + `get-lead-context` (token-budgeted).
5. Guardas determinísticos pré-modelo: pedido de humano / opt-out ambíguo → handoff.
6. Loop de tools (`generateText` via `runModelCall` — único seam de LLM, 23 "pontos de IA", orçamento mensal atômico) com tools nativas + 60 tools MCP (efêmero token, `BLOCKED_TOOL_IDS`).
7. Envio **só** via `send_message` → cadeia before-send v6 (9 gates: stop, LGPD, pacing, janela, spinning, promessa determinística + semântica, case-promise, vazamento interno, disclosure) → adapter com `send_ledger` (intenção exactly-once, entrega at-least-once).
8. Chamada de fechamento (checkpoint + declaração Zod strict) → diffs na timeline; Operator turn opcional.

## 4. Barramento de eventos (CONFIRMADO)

- **Triggers Postgres emitem no MESMO commit** (`trg_messages_emit_event`, `trg_emit_event_on_lead_change`, `trg_emit_conversation_routing`…): nunca HTTP dentro de trigger.
- **Dois consumidores**: (a) drain genérico de `event_log` (cron 1 min, claim por CAS condicional, 50/tick, reaper de órfãos 10 min, backoff 2^n, `dead` após 5 tentativas — **silencioso**); (b) `job_queue` do agent-engine (advisory lock + `FOR UPDATE SKIP LOCKED`, visibility timeout, dead-letter **com alerta na Central**, `completeJob(inSameCommit)` = exactly-once de efeito).
- Idempotência por consumidor via `consumed_by text[]`; event→job dedup por unique parcial; envio dedup por `send_ledger unique (job_id, seq)`.
- Redis é **apenas otimização** (rate limit, debounce de RAG): efêmero no compose, todo consumidor tem modo degradado definido.

## 5. Modos de deploy (fat que muda o comportamento)

| | VPS self-host (kit HostGator) | Vercel |
|---|---|---|
| Crons | ✅ 22 rotas via `scheduler` | ⚠️ só `lgpd-sla-watcher` (Hobby 1×/dia) — **fila fica pendente** |
| Worker 24/7 | ✅ container `worker` | ❌ sem equivalente |
| Vitrine/produção | **é a operação real do produto** | vitrine/demos (decisão pendente do dono) |

CONSEQUÊNCIA para a transformação: o produto-alvo (AI Revenue & Order Operations OS) **é um produto de VPS**; qualquer fluxo novo (order engine, ERP sync) deve assumir worker + scheduler presentes, e o drain genérico não é o caminho para dinheiro.

## 6. O que a arquitetura É e NÃO é

**É**: monólito modular Next.js + worker separado, banco como barramento (outbox por trigger), multi-tenant RLS-first, self-host-first, governança (RBAC, audit append-only, guardrails) como produto.

**Não é** (confirme antes de assumir no plano): não há fila externa (Kafka/SQS/Redis streams — Redis é descartável); não há MCP *client* (o agente chama tools in-process; transporte HTTP MCP do agente foi removido — `lib/agent-engine/edge/crm/mcp-client.ts`); não há multi-canal real (CHECK de `conversations.channel` só 'whatsapp'; meta_cloud/zernio são *provedores de transporte* de WhatsApp, não canais novos); não há comércio nativo (`orders` sem escritor, sem `order_items`); não há CSP/HSTS; não há gitleaks.

## 7. Dívida estrutural relevante para a transformação

1. `lib/agent-engine/agent/inbound-turn.ts` — 4.083 linhas, hot path do produto (cresceu de 1.789 em 2026-07-29). Qualquer agente novo (order/recovery) que crescer ali repete o problema.
2. Caminho legado paralelo: `lib/ai/dispatcher` + `ai-response-worker` coexistem com o agent-engine (governado por `AGENT_DISPATCH_CONSUMER`). Dois caminhos de IA = dois pontos de mudança para cada feature de IA.
3. Drain genérico (`lib/event-log/drain.ts`) um nível abaixo do `job_queue`: sem SKIP LOCKED, sem dedup key genérica, dead-letter silencioso, 4 rotas com `Idempotency-Key` real. Documentado no doc 07.
4. `conversations.channel` vestigial + provider-union em `lib/channels/types.ts`: adicionar Instagram/Messenger exige tocar CHECK de banco + union + capabilities + adapter + rota neutra (o caminho está preparado — `webhooks/channel/[token]` — mas é mudança de schema).
5. Fire-and-forget `void admin.from("event_log").insert(...)` em rotas de admin (eventos podem se perder silenciosamente — doc 07 §10).
