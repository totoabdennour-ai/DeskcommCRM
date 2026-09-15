---
type: our-product/phase-0-audit
doc: 12-reuse-decision-matrix
status: final
created: 2026-09-14
decisions_allowed: KEEP | ADAPT | EXTEND | REBUILD | REMOVE | INTEGRATE | REFERENCE ONLY
effort: S ≤1 sprint · M 1-3 sprints · L >3 sprints (equivalente a 1 engenheiro sênior + IA)
---

# 12 — Matriz de decisão de reuso

| Subsistema | Implementação atual (evidência) | Decisão | Razão | Risco | Esforço | Dependências |
|---|---|---|---|---|---|---|
| Multi-tenancy + RLS (orgs, papéis, policies, invariantes) | RLS total + varredura de catálogo em CI | **KEEP** | É o fundamento; provado em CI | Baixo | — | — |
| Auth/MFA/RBAC/impersonation | getUser + requireRole 241 usos + suporte DB-gated | **KEEP** | Acima da média; gates de lint | Baixo (fechar R3/R8 barato) | S | — |
| Conversas/mensagens/inbox (3 painéis, realtime) | saída única, idempotência, realtime com refetch de segurança | **KEEP** | Hot path maduro | Baixo | — | — |
| Canais WhatsApp (WAHA + Meta Cloud + Zernio) | HMAC fail-closed, capabilities, anti-ban, templates | **KEEP** | Canal primário do produto | Baixo | — | — |
| Multimodal de mídia (áudio/imagem/PDF/vídeo→texto) | derive worker + whisper/vision/pdfjs, gating de dispatch | **ADAPT** | Base pronta; cap 8k chars e 1-anexo só na última msg limitam ordering | Médio | S-M | Fase 6 (multimodal) |
| Agent engine (turno, guardrails, fila, pacing, budget) | inbound-turn 4.083 l.; before-send v6; job_queue SKIP LOCKED | **KEEP** + **EXTEND** com módulos novos | O ativo mais difícil de reconstruir; extensão deve evitar crescer inbound-turn | Médio (god-file) | — | Fase 5 |
| RAG por tenant (chunks 1536d, ivfflat, versionamento) | ingest→chunk→embed→RPC org-scoped | **KEEP** + EXTEND (catálogo vivo) | Consumidor product_synced pronto, emissor ausente | Baixo | S | Fase 3 |
| MCP server (60 tools, scopes, audit) | Bearer hash, BLOCKED ids, efêmero token | **KEEP** + EXTEND (`crm_create_order`, pricing) | Contrato de nomes congelado | Médio (nova tool = superfície) | M | Fase 4-5 |
| Guardrail de promessa (minPrice/maxDiscount) | tabela versionada + engine determinístico + semântico | **ADAPT** → política comercial por conta | Hoje é knob global de org; alvo é conta-preço | Baixo | M | Fase 3 |
| CRM funil (pipelines, leads, atividades, vocabulary) | value_cents, owner, fractional indexing | **KEEP** | Vocabulary default já diz "Pedido" | Baixo | — | — |
| **Catálogo (catalog_products)** | SKU único, busca token-wise, import CSV, custo_cents sem leitor | **EXTEND** | Adicionar unidade, preço por lista/conta, vínculo a order_items | Baixo | M | Fase 3 |
| **Orders (espelho)** | header-only, sem escritor, 4 leitores vivos | **ADAPT** (mudança de contrato: origem manual/internal) | Reusa leitores/LGPD/admin; alternativa tabela nova descartada por custo | **Médio-alto** (migration com dados vivos) | M | Fase 4 |
| **Order Engine (order_items, order_events, estados, MOQ/crédito)** | inexistente | **BUILD** | Coração do produto-alvo | Alto (dinheiro) | L | Fase 4 |
| **Pricing (price_lists, account_prices, desconto)** | inexistente (promise-table é guardrail, não preço) | **BUILD** | Requisito B2B central | Médio | M-L | Fase 3 |
| **Accounts (empresa B2B, condições, limite, rep)** | inexistente (contacts = pessoa física) | **BUILD** | Requisito B2B central | Médio | M | Fase 2 |
| Nuvemshop (OAuth + webhooks) | OAuth completo; sync produto/pedido ausente | **KEEP** (B2C de referência) + sync opcional | Não é o caminho B2B; consumidor RAG faminto é barato de alimentar | Baixo | S (sync produto) | Fase 3 opcional |
| **ERP Gateway + adapters** | inexistente | **BUILD** (ERPNext primeiro) | Doc 10 | Alto (externo) | L | Fase 9 |
| **Revenue recovery (detector monetário)** | radar por temperatura; reativação expira | **EXTEND** | Juntar orders+silêncio+estágio com valor | Médio | M | Fase 8 |
| Automações QUANDO/SE/ENTÃO | 7 ações, engine com anti-loop e janela | **KEEP** + EXTEND (ações de pedido se demanda) | Base sólida | Baixo | — | — |
| Follow-up adaptativo + Radar | engine 877 l., gatilhos por etapa | **KEEP** | Completo e vigiado por invariantes | Baixo | — | — |
| Agenda + Google Calendar | 7 tabelas, sync bidirecional | **KEEP** | Fora do caminho crítico B2B | Baixo | — | — |
| LGPD (export/redact/consent/SLA) | cascata irreversível, PAdES, storage queue | **KEEP** + estender para orders/accounts | Redact já preserva totais de orders | Baixo | S | Fase 4 |
| Eventos/workers (event_log + job_queue + crons) | outbox transacional, SKIP LOCKED, reapers | **KEEP** + endurecer dead-letter/fire-and-forget | Doc 07 | Baixo | S | Fase 1 |
| Métricas (funil, atendente, atrito, ads) | SQL puro + views RLS-scoped | **EXTEND** (receita: orders no funil) | Hoje o valor é do lead, não do pedido | Baixo | M | Fase 4+ |
| Self-host kit (install/update/backup/agent) | imagens CI, baseline auto-curativo, update pela tela | **KEEP** | É o modelo de monetização | Baixo | — | — |
| White-label/marca | banco acima do .env, resolvedores que nunca lançam | **KEEP** | Essencial para revenda B2B | Baixo | — | — |
| Caminho legado de IA (`lib/ai/dispatcher` + ai-response-worker) | paralelo ao agent-engine (knob AGENT_DISPATCH_CONSUMER) | **REMOVE** (após migração) | Dois caminhos = dois pontos de mudança por feature IA | Médio (migração) | M | Fase 1/10 |
| `conversations.channel` CHECK 'whatsapp' | vestigial | **ADAPT** quando multicanal real | Caminho neutro já preparado | Médio (migration) | S | Fase 6+ |
| Instagram/Messenger adapters | inexistente | **BUILD** (fase tardia) | Caminho preparado (rota neutra, padrão zernio) | Médio | M | doc 16 |
| n8n | ausente do repo; consumível via webhooks | **INTEGRATE opcional / fora do core** | Doc 10-11: core não ganha nada | Baixo | — | — |

**Síntese**: dos ~30 itens, **18 KEEP**, **6 EXTEND/ADAPT**, **4 BUILD** (Order Engine, Pricing, Accounts, ERP Gateway), 1 REMOVE planejado, n8n fora do core. A base reusável é a maior parte do valor (plataforma, canais, IA, LGPD, self-host) — a construção nova concentra-se no domínio de pedidos.
