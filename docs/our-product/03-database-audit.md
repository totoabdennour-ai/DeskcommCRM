---
type: our-product/phase-0-audit
doc: 03-database-audit
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d
evidence: supabase/baseline.sql (24.068 l.), supabase/migrations/ (219 arq.), lib/database.types.ts
---

# 03 — Auditoria de banco de dados

## 1. Forma do schema (CONFIRMADO)

- **219 migrations** versionadas `<timestamp>_<NNNN>_<slug>.sql` + `MANIFEST.md`. **`baseline.sql` é o schema canônico** (dump schema-only §B:938–4900 com guardas idempotentes + apêndice idempotente §B:5243–23955): é o que o kit self-host aplica em `install` (ON_ERROR_STOP=1) e `update` (re-aplicação). As migrations 0001–0009/0013 são stubs — **a cadeia fresh não sobe do zero**; quem sobe banco novo é o baseline.
- Extensões: `uuid-ossp`, `pgcrypto`, `vector` criadas em migrations; **`citext` e `pg_trgm` são assumidas pré-instaladas** (criadas só em `scripts/test-db.sh` e `scripts/selfhost-prelude.sql`) — instalar num Postgres fresco exige o prelude antes do baseline.
- Convenções: `organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE` em toda tabela tenant-aware; `type` = text + CHECK (exceção deliberada: vocabulário aberto onde clone legado existe); dinheiro `*_cents bigint` + `currency bpchar(3)`; `created_at/updated_at` em toda tabela (27 triggers `fn_set_updated_at`); **zero `deleted_at`** — soft-delete é por estado (`is_anonymized`, `revoked_at`, `archived_at`, `superseded_at`, `is_merged_into`); atores por `created_by`/`performed_by_user_id`/`created_by_kind`.
- **~130 tabelas**, 3 views (`security_invoker=true`), 232 funções (~188 SECURITY DEFINER com `search_path` fixado e varredura de hardening no CI), 113 triggers.
- Vetor: `ai_chunks.embedding vector(1536)`, índice **ivfflat cosine lists=100**.

## 2. Inventário por domínio

**Plataforma/org**: `organizations` (slug citext único, `settings`/`onboarding_state` jsonb, `currency` desde 0208, status active/suspended/redacted/archived), `user_organizations` (role CHECK viewer/agent/manager/admin), `platform_admins` (scope full/support_readonly), `team_invites` (0238), `platform_branding`, `platform_support_sessions`, `platform_google_oauth`, `system_version`, `system_update_runs`, `idempotency_keys`, `incidents`, `private.app_secrets` (schema `private`, sem grants públicos).

**CRM**: `crm_pipelines` (`vocabulary` jsonb — default já renomeia deal→"Pedido", `settings.fields[]` define custom fields), `crm_stages` (position numeric, is_won/is_lost mutex, `requires_human`), `crm_leads` (status open/won/lost, `value_cents`+currency, `owner_user_id`/`owner_agent_id`, `expected_close_date`, custom_fields, unique parcial org+source+external), `crm_lead_activities` (timeline append-only, type vocabulário aberto ~40 tipos TS), `crm_lead_links` (polimórfico: order/conversation/message/appointment/contact/lead/external), `crm_lead_scores`, `crm_lead_risk_states`, `crm_lead_reactivations`, `crm_tasks`, `demandas`+`demanda_conversas` (casos de serviço — dono sempre presente ia|humano, `proximo_passo` obrigatório), `lead_notes`, `lead_state(+_transitions)`, `lead_checkpoints`, `merge_queue`, `contact_field_proposals`, `event_service_origins`.

**Conversas/mensagens**: `contacts` (pessoa física — sem conceito de empresa; `cpf_encrypted`/`cpf_hash`, `consent` jsonb por finalidade, `is_anonymized`, `is_merged_into`, `force_human`), `conversations` (CHECK channel **só 'whatsapp'**; status 9 valores; `bot_silenced_until`; unique org+contact+session+group), `messages` (type/direction/status/sent_via CHECKs, `media_*`, `media_derived_text`, unique **DEFERRABLE** (org, external_id)), `message_templates`, `voice_calls`/`org_voice_calls`, `ai_reply_drafts`, `agent_inbox_items` (Central de avisos), `agent_cases`+`agent_case_events`.

**Canais**: `channel_sessions` (provider CHECK waha/meta_cloud/zernio/wacalls, `webhook_path_token`, `webhook_secret_encrypted`, status STARTING…FAILED, `daily_message_limit`), `channel_session_warmup` (sem escritor), `channel_session_health`, `channel_knobs`, `pacing_ledger`, `outbound_copies`, `before_send_traces`, `channel_routing_policies`+`_responsibles` (DML revogado — escrita só via RPC MFA-gated), `channel_connection_requests`, `meta_templates` (espelho Graph API com `contract_hash`), `watchdog_cursors` (RLS sem policy = só service role).

**IA**: `ai_agents`/`ai_agent_versions` (imutáveis por trigger; provider, token/cost budgets, `tool_ids`, `pipeline_ids`, `handoff_keywords`, `video_frames_enabled`), `ai_agent_runs`, `ai_budgets` (org = PK), `ai_models`/`ai_pricing` (catálogo sincronizado do OpenRouter), `ai_provider_credentials` (AES-256-GCM) + view `_safe`, `ai_purpose_bindings` (23 pontos), `ai_routers`/`_members`/`_decisions`, `llm_calls` (tokens in/out/cache, `cost_cents` NULL = preço desconhecido), `flywheel_judge_verdicts`, `flywheel_distiller_proposals`.

**RAG**: `ai_knowledge_sources` (source_type incl. nuvemshop_catalog), `ai_knowledge_versions`, `ai_chunks`, `ai_faq_items`, `knowledge_searches`, `org_memory_versions/pointers/entries`.

**Harness/automação**: `job_queue` (kind CHECK, unique parcial 1-running-per-contact, unique (org, source_event_id)), `send_ledger` (unique (job_id, seq), body_hash), `playbook_versions/pointers`, `skill_versions/pointers/activations`, `promise_table_versions/pointers` (`minPriceCents`, `maxDiscountPercent`, `maxInstallments`), `disclosure_*`, `reentry_*`, `followup_flow_versions/pointers/enrollments/enrollment_events`, `automation_rules/runs`, `cron_jobs`, `metrics`.

**LGPD**: `lgpd_requests` (type/scope/source, `due_at`, `cascaded_to`), `storage_redaction_queue`, consent no contato.

**Webhooks**: `webhook_events_log` (provider waha/nuvemshop/generic, raw_body, valid_signature), `webhook_sources`, `webhook_lead_captures`, `tenant_integrations` (provider CHECK nuvemshop/vtex/shopify, tokens cifrados via `fn_encrypt_oauth`).

**Comércio**: `orders` (**espelho header-only**: external_provider CHECK nuvemshop/vtex/shopify, external_id, status 7 valores, fulfillment_status, total_cents+currency, payment_method, tracking_code, **`payload jsonb` = únicas linhas do pedido**, `is_anonymized`; unique (org, provider, external_id)), `catalog_products` (0204: `codigo` SKU único por org, preco_cents, **custo_cents** (piso de desconto, hoje lido por ninguém), `controla_estoque`, quantidade, origem manual/planilha/nuvemshop, GIN trgm em nome), `nuvemshop_products` (espelho **sem escritor no repo inteiro**).

**Agenda**: 7 tabelas `calendar_*` + `attendant_availability` + `appointment_recovery_receipts`.

**Ads**: `ad_platform_connections`, `ad_conversion_dispatches` (ledger determinístico com value_cents), `ad_insights_connections`.

## 3. RLS (CONFIRMADO)

- **Toda tabela org-scoped tem RLS**: 38 statements no dump + ~65 no apêndice (incl. loops dinâmicos). 134 policies.
- Padrão canônico: `tenant_isolation_<tabela>_all USING (organization_id IN (SELECT * FROM public.fn_user_org_ids())) WITH CHECK (...)` + `REVOKE ALL ... FROM anon`.
- `fn_user_org_ids()` (SECURITY DEFINER): memberships ativas UNION org de sessão de suporte ativa. `fn_user_role_in_org` resolve papel (suporte full→admin/viewer).
- Casos especiais deliberados: `watchdog_cursors` e `platform_branding` (RLS **sem policy** = só service role); `ad_*_connections` com revoke total + grant service_role; `private.app_secrets` em schema sem grants.
- **Porta isso por testes**: `rls-isolation.test.ts` (2 orgs, JWT simulado pelo mesmo caminho de produção, org A vê ZERO linhas da org B) + `rls-completude-varredura.test.ts` (deriva a lista de tabelas do catálogo e força cada uma no teste ou exceção nomeada — nasceu de policy sabotada com `or true`).
- `api_audit_log`: append-only por GRANT (SELECT,INSERT apenas; sem UPDATE/DELETE para ninguém, nem service_role) + expurgo só pela `fn_expurgar_auditoria_vencida` (EXECUTE só service_role; piso 90d no corpo).

## 4. O schema suporta os 27 conceitos do produto-alvo?

Legenda: ✅ existe · 🟡 parcial · ❌ ausente. "Local recomendado" é RECOMENDAÇÃO desta auditoria; nada foi implementado.

| Conceito | Estado | Evidência / Lacuna → Local recomendado | Risco de migration |
|---|---|---|---|
| Tenant | ✅ | `organizations` | — |
| User / Staff | ✅ | `auth.users` + `user_organizations` (4 papéis) | — |
| **Customer Account (empresa B2B)** | ❌ | `contacts` é pessoa física (comentário do schema: "Pessoa física no escopo de um tenant"); nenhuma coluna company/account em lugar algum | Nova tabela `accounts` (tenant-aware) + `contacts.account_id` nullable. Baixo (aditivo), médio se integrar a pricing/orders |
| Customer Contact | ✅ | `contacts` (+ `account_id` novo para vincular) | Baixo |
| Channel Identity | ✅ | `contacts.wa_identity` gerado (phone/lid), `fn_upsert_wa_contact` | — |
| Conversation / Message | ✅ | `conversations`/`messages` (idempotência por external_id DEFERRABLE) | — |
| Product | 🟡 | `catalog_products` (0204) é flat 1-linha-por-SKU, sem taxonomia pai/filho | Estender (categoria estruturada) ou manter flat — decisão doc 14 |
| SKU | ✅ | `catalog_products.codigo` único por org, é a chave de busca do agente | — |
| **Variant** | ❌ (deliberado) | 0204: "o que tem preço é o SKU" — 4 capacidades × 3 cores = 12 linhas | Manter flat (invariantes já travam a filosofia) — RECOMENDAÇÃO: não introduzir matriz de variantes na Fase 2 |
| **Unit of Measure** | ❌ | quantidade é int sem unidade; nada de caixa/kg/un | Coluna `unidade` em `catalog_products` + fator de conversão se necessário. Baixo, mas toca fluxo de order items |
| **Price List** | ❌ | preço único `preco_cents`; "tabela de preços" só existe como documento RAG | Nova tabela `price_lists` + `price_list_items` (produto×lista) |
| **Customer Price** | ❌ | nada de contato×produto×preço | `account_prices` (account×product) ou condições na `price_lists` com `accounts.price_list_id` |
| Discount | 🟡 | só guardrail de IA (`promise_table.maxDiscountPercent`); sem entidade de desconto | Desconto por linha de pedido + política por conta |
| Minimum order | ❌ | nada (nem MOQ nem valor mínimo) | Campo em `accounts`/`price_lists` |
| Stock (on-hand) | 🟡 | `catalog_products.quantidade`+`controla_estoque` (só filtro de visibilidade) | Reuso direto; reservation é novo |
| **Stock decrement/reservation** | ❌ | nenhum write path decrementa | No order engine (reserva no fechamento, baixa no faturamento) |
| Warehouse | ❌ | nada | Fase tardia; campo `warehouse` em order/inventory se multi-CD for exigido |
| **Sales Order (nativo)** | ❌ | `orders` é espelho externo SEM escritor (`external_provider` CHECK não tem 'manual'); header-only | **Reusar `orders` com mudança de contrato**: CHECK ganha `('manual','internal')` ou coluna `origin`; aí a tabela nasce para o que será |
| **Sales Order Items** | ❌ | zero linha-item no schema; `orders.payload` jsonb é o único carregador | Nova tabela `order_items` (order_id, product_id, sku snapshot, qty, unit_price_cents, discount, total) |
| Order Event / Modification | ❌ | sem histórico de emenda | `order_events` append-only (evento de domínio, alimenta `event_log`) |
| Delivery | 🟡 | `fulfillment_status`+`tracking_code` existem, nunca populados | Reuso no modelo de espelho; nativo ganha delivery via ERP |
| Sales Representative | 🟡 | `owner_user_id`/`owner_agent_id` no lead; sem atribuição cliente→rep, cota ou comissão | `accounts.owner_user_id` (RECOMENDADO primeiro passo) |
| Human Handoff | ✅ | `contacts.force_human`, `bot_silenced_until`, demandas, agent_inbox_items | — |
| Notification | ✅ | `agent_inbox_items`, web push VAPID, `user.mentioned` | — |
| Revenue Opportunity | 🟡 | radar (`crm_lead_risk_states`) é por temperatura/estágio, **não por valor**; não junta `orders` | Estender radar com join a orders + valor em risco |
| Revenue Recovery Event | ❌ | só reativação de lead (`crm_lead_reactivations`, expira) | `recovery_events` ou reuso da reativação com motor de detecção novo |
| Integration | ✅ | `tenant_integrations` (provider CHECK inclui vtex/shopify — antecipa ERP) | CHECK ganha providers de ERP |
| Audit Event | ✅ | `api_audit_log` append-only + `event_log` + `*_activities` | — |

**Veredito**: a fundação (tenancy, RLS, eventos, auditoria, LGPD, conversa, catálogo básico) suporta o produto-alvo com **extensões aditivas**. O que falta é um **domínio de pedidos inteiro** (order + items + eventos + pricing) — construído como migration nova + apêndice no baseline + MANIFEST (tripla doutrina do repo). Nenhuma tabela existente precisa ser quebrada; o ponto de maior decisão é a **mudança de contrato de `orders`** (espelho externo → pedido nativo com origem) que afeta o CHECK, os leitores existentes (LGPD export preserva totais; painel do inbox; MCP `crm_list_contact_orders`) e a única constraint unique 3-colunas.

## 5. Riscos de banco a carregar no plano

1. **pg_trgm/citext fora do baseline** — prelude obrigatório; já mapeado (`docs/` + scripts/selfhost-prelude.sql), mas é pegadinha de instalação fresca.
2. **`orders` sem escritor** é schema morto que já tem 4 leitores — mudança de contrato precisa atualizar LGPD redact (preserva totais), `crm-summary`, MCP comercio, admin stats.
3. **Sem partição/matview**: relatórios de receita em volume (order events, llm_calls) crescerão; Fase de hardening pode exigir índices/retenção adicionais (já existe política de retenção para `job_queue`/webhooks/audit).
4. **`conversations.channel` CHECK travado em 'whatsapp'** — multicanal real exige migration com dedupe prévio (doutrina: corrigir dados ANTES de criar constraint).
