---
type: our-product/phase-0-audit
doc: 19-phase-0-executive-summary
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d
---

# 19 — Sumário executivo da Fase 0

**Método**: 7 varreduras de auditoria read-only sobre o código em `5c132f4d` (270 rotas, 219 migrations, ~130 tabelas, 548+189+103 arquivos de teste) + leitura da doutrina. Todo fato carrega arquivo de evidência nos docs 01-09. FACT/INFERÊNCIA/RECOMENDAÇÃO discriminados.

## As 15 respostas

**1. Deskcomm é fundação adequada? SIM — acima da média.** A infraestrutura difícil já existe e é vigiada por gate: multi-tenancy RLS com varredura de catálogo em CI, outbox transacional por trigger, fila durável com SKIP LOCKED + dead-letter com alerta, guardrails before-send versionados, LGPD real, self-host kit com baseline auto-curativo, 5 checks obrigatórios. O que falta é um **domínio inteiro** (pedidos/pricing/contas/ERP) — construção aditiva, não reescrita.

**2. Quanto se reusa?** ~70% do produto-alvo (qualitativo): 18 subsistemas KEEP, 6 EXTEND/ADAPT, 4 BUILD (doc 12). As partes caras de acertar (tenancy, canais, IA runtime, LGPD, packaging) estão feitas.

**3. O que se mantém (KEEP)**: multi-tenancy/RLS; auth/RBAC; conversas/inbox; canais WhatsApp (WAHA+Meta+Zernio); agent-engine (turno, guardrails, fila, pacing, budget); RAG; MCP server; CRM funil; automações; follow-up/radar; agenda; LGPD; métricas base; self-host kit; white-label.

**4. O que se adapta (ADAPT)**: `orders` (espelho→nativo com `origin`), guardrail de promessas (knob global→política por conta), multimodal (caps/visão para pedido), RAG de catálogo (alimentar o consumidor órfão), `conversations.channel` (quando multicanal real).

**5. O que se constrói (BUILD)**: Order Engine (`order_items`, `order_events`, lifecycle, idempotência), Pricing (listas + preço por conta + MOQ), Accounts (empresa B2B), ERP Gateway (ERPNext primeiro), Revenue Recovery monetário.

**6. O que se remove (REMOVE)**: caminho legado de IA (`lib/ai/dispatcher` + `ai-response-worker`) após migração — dois caminhos por feature de IA é dívida contínua. Nada mais justifica remoção.

**7. O que permanece externo**: ERP (ERPNext/Odoo/custom — doc 10), WAHA (licenciado, tag fixa), Supabase/Auth/Storage, Redis efêmero, **n8n** (opcional ao operador, nunca no core — ver 9).

**8. Como o n8n mapeia**: 6 dos 11 comportamentos do protótipo já existem em código melhor (resolver, identidade, handoff, escalation, notificação, audit); os 5 restantes (order create/lifecycle/modification/idempotency-server/retry-ledger) viram os requisitos do Order Engine com precedentes de padrão no repo (doc 11, tabela completa). OPEN QUESTIONS de regra de negócio aguardam o export dos workflows.

**9. n8n no core? NÃO.** Justificativa técnica: duplicaria o barramento sem os primitivos de dedup/ledger/advisory-lock/RLS, fora do alcance dos invariantes de CI; a integração desejada (8 operações) é menor que o custo de operar n8n. Webhooks de saída com SSRF guard já cobrem o operador que quiser n8n/Zapier.

**10. ERPNext como?** Sistema externo atrás de um ErpAdapter único (8 operações, doc 10), com: leitura on-demand para estoque/preço no turno do agente (cache curto), escrita assíncrona por job_queue, outbox no mesmo commit, `sync_ledger` (irmão do `send_ledger`) com reconciliação e dead-letter com alerta, credenciais cifradas por org, adapter clean-room (GPL sem copiar código).

**11. Maiores riscos técnicos**: (a) migração de contrato de `orders` com 4 leitores vivos; (b) drain genérico usado como atalho para dinheiro (regra: job_queue apenas); (c) god-file inbound-turn (agentes novos em módulos); (d) ERP externo instável (sync_ledger como design de falha).

**12. Maiores riscos de segurança**: R1 — service-role sem gate de escrita (149/270 rotas; handler novo vaza cross-tenant com CI verde) → gate na Fase 1; R2 — CPF com hash sem salt + controle declarado não provisionado; R4/R5 — sem rate limit em superfícies de secret, sem CSP/HSTS; R7 — 363 PNGs de evidência sem revisão de PII, sem gitleaks. (T1/T5/T6 do threat-model de 2026-07-29 já resolvidos; T2/T3/T4/T7 parcialmente abertos — doc 08.)

**13. Maiores riscos de produto**: posicionamento B2B sem matar o multi-nicho; confiança em pedido conversacional (confirmação explícita obrigatória); ERP do piloto como fonte de falha percebida.

**14. Fase 1 recomendada**: **Estabilização de fundação** — dead-letter com alerta + fim do fire-and-forget de eventos, gate de org em handlers service-role, remover dev-fallback do convite, rate limit por prefixo, CSP/HSTS, gitleaks, decisão CPF. Tudo pequeno, independente e pré-requisito de qualquer fluxo de dinheiro.

**15. Arquivos exatos da Fase 1**: `lib/event-log/drain.ts` (alerta dead), `app/api/v1/admin/*` e `app/app/ai/agents/[id]/_actions.ts` (emissão transacional), `tests/unit/varredura-org-em-handlers-admin.test.ts` (novo), `lib/auth/invite-token.ts` + `lib/env.ts` + `.env.example` (fallback), `proxy.ts` + `lib/auth/rate-limit.ts` (rate limit de borda), `next.config.ts` + `Caddyfile` (headers), `.github/workflows/ci.yml` (gitleaks), `lib/contacts/cpf.ts` + migration de `encrypt_cpf` (ou decisão documentada). Nenhum desses toca comportamento de produto visível.

---

## STOP CONDITION respeitada

Nenhum código de produto foi alterado; nenhuma migration criada; nenhum refactor; nenhuma dependência adicionada. A saída desta fase é exclusivamente `docs/our-product/` (docs 01-19 + DECISIONS.md), produzida na branch `phase-0-audit`, **aguardando revisão do dono antes de qualquer implementação**.
