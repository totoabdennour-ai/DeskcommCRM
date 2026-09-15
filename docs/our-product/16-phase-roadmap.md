---
type: our-product/phase-0-audit
doc: 16-phase-roadmap
status: final
created: 2026-09-14
type_note: RECOMENDAÇÃO para revisão do dono. Fase 0 (esta) termina aqui; nenhuma fase seguinte começou.
---

# 16 — Roadmap de implementação

Convenção: toda fase entrega com o DoD do repo (typecheck/lint/unit verdes, `test:db` se schema, `test:e2e` com evidência visual se UI, triple de migration, fragmento `.changes/`). "Rollback" = como desfazer sem dano (padrão: migrations são aditivas; features por knob/ponteiro).

---

## FASE 0 — Auditoria (esta) ✅
**Objetivo**: entender e planejar. **Entregue**: docs/our-product/01-19 + DECISIONS. **Aceite**: revisão do dono. **Rollback**: n/a.

---

## FASE 1 — Estabilização de fundação
- **Objetivo**: fechar as dívidas de confiabilidade/segurança que qualquer fase de dinheiro herda.
- **Arquivos/módulos**: `lib/event-log/drain.ts` (alerta de dead-letter), rotas admin com `void insert` → emissão transacional, novo `tests/unit/varredura-org-em-handlers-admin.test.ts` (gate R1), `lib/auth/invite-token.ts` (remover dev-fallback), rate limit por prefixo no `proxy.ts` (R4), headers CSP/HSTS (R5), gitleaks no CI (R7), decisão/provisão do CPF (R2: migration `encrypt_cpf` OU documentação de hash-pseudônimo).
- **Banco**: possivelmente 1 migration (CPF); nenhuma obrigatória.
- **APIs**: nenhuma nova; endurecimento das existentes.
- **IA**: nenhuma.
- **Testes**: gates novos (varredura org, cron-audit estendida), gitleaks.
- **Segurança**: R1-R7 do doc 08.
- **Aceite**: threat-model re-auditado sem HIGH aberto; suíte verde nos 5 checks.
- **Dependências**: nenhuma. **Rollback**: cada item é independente e reversível.

## FASE 2 — Domínio B2B (contas)
- **Objetivo**: empresa como entidade de primeira classe.
- **Arquivos**: `lib/accounts/`, telas `app/app/accounts/`, `app/api/v1/accounts/`, extensão do customer 360.
- **Banco**: `accounts` (owner, condições, prazo, limite, MOQ, price_list_id), `contacts.account_id`, apêndice baseline + MANIFEST.
- **APIs**: CRUD accounts (requireRole manager+), vínculo contato↔conta.
- **IA**: tool MCP `crm_get_account`/`crm_list_accounts` (nomes novos).
- **Testes**: invariantes RLS das tabelas novas; e2e de conta pela tela.
- **Segurança**: dados de empresa = dados pessoais (LGPD cascade estendida).
- **Aceite**: criar conta, vincular contato, ver 360 com pedidos da conta.
- **Dependências**: Fase 1. **Rollback**: tabelas aditivas; knob para esconder telas.

## FASE 3 — Catálogo / inteligência de SKU & pricing
- **Objetivo**: preço por cliente/lista; MOQ; unidade.
- **Arquivos**: `lib/pricing/`, `lib/catalogo/` (unidade, sinônimos), telas de listas de preço.
- **Banco**: `price_lists`+`price_list_items` (+validade), `account_prices`, `catalog_products.unidade`.
- **APIs**: CRUD de listas; endpoint de resolução de preço (usado por API e agente).
- **IA**: adaptar promise-table para política por conta; tool `crm_quote_price` (nome novo).
- **Testes**: invariante "resolução de preço determinística"; e2e cotação pela conversa.
- **Aceite**: agente cota preço correto para conta A e conta B com listas diferentes.
- **Dependências**: Fase 2. **Rollback**: promise-table continua funcionando como hoje (knob global).

## FASE 4 — Order Engine
- **Objetivo**: pedido nativo com itens, eventos, estados — a peça central.
- **Arquivos**: `lib/orders/`, `app/api/v1/orders/`, drainer dedicado (job_queue), extensões LGPD/admin/metrics.
- **Banco**: migration `orders.origin` (dedup antes do CHECK), `order_items`, `order_events`, `erp_sync_ledger` (estrutura, sem ERP ainda); idempotency_keys adotada na rota de criação.
- **APIs**: `POST /orders` (Idempotency-Key), `GET/PATCH`, tool MCP `crm_create_order` + `crm_get_order`.
- **IA**: schema de rascunho de pedido (2º generateObject do repo) + confirmação explícita antes de confirmar.
- **Testes**: invariantes 1-8 do doc 14 (RLS, soma, emenda, idempotência, outbox); e2e pedido pela conversa com evidência.
- **Segurança**: gate de service-role da Fase 1 é pré-requisito; audit em toda mutação.
- **Aceite**: pedido criado por conversa, confirmado, emendado, visível na conta/inbox, contabilizado no funil (value do pedido substitui value digitado na métrica de receita).
- **Dependências**: Fase 3. **Rollback**: origin='manual' desligável; leitores existentes degradam como hoje.

## FASE 5 — Agentes de venda & pedido
- **Objetivo**: os agentes operarem o domínio novo ponta a ponta.
- **Arquivos**: extensões em `lib/agent-engine/` (módulo próprio, sem crescer inbound-turn), prompts playbooks B2B, skills de pedido.
- **Banco**: nenhuma (reusa). **APIs**: nenhuma nova (tools).
- **IA**: tools de pedido/pricing nos tool_ids; guardrail de confirmação de pedido no before-send (gate novo declarativo); handoff para vendedor com rascunho.
- **Testes**: golden-candidates de pedido; e2e conversa→pedido→confirmação; testes de custo/budget.
- **Aceite**: piloto interno: 10 pedidos conversacionais sem erro de preço/quantidade.
- **Dependências**: Fase 4. **Rollback**: tools desabilitáveis por tool_ids (knob existente).

## FASE 6 — Ordering multimodal
- **Objetivo**: pedido por voz/imagem/PDF.
- **Arquivos**: `lib/messaging/media/` (levantar cap com budget de tokens, novo propósito de visão "captura de pedido"), parser de itens de PDF; multicanal real (Instagram/Messenger) **só se demanda** — migration do CHECK `conversations.channel`.
- **Testes**: e2e com PDF de pedido real; unidades de extração.
- **Aceite**: cliente manda foto/PDF da lista e o agente devolve rascunho de pedido correto.
- **Dependências**: Fase 5. **Rollback**: propósitos novos desligáveis por ponto de IA.

## FASE 7 — Operações humanas
- **Objetivo**: o time do distribuidor operar pedidos/contas pela tela.
- **Arquivos**: telas de fila de pedidos (rascunho→confirmar→expedir), separação/faturamento mínimos, Central com kinds order_*.
- **Banco**: nada novo (order_events alimenta). **APIs**: transições de estado por UI.
- **Aceite**: vendedor humano assume pedido rascunho do agente e confirma pela tela (e2e).
- **Dependências**: Fase 4. **Rollback**: telas novas sem migração.

## FASE 8 — Revenue recovery
- **Objetivo**: detecção e execução de recuperação monetária.
- **Arquivos**: `lib/receita/` (detector orders×silêncio×estágio), estender radar com valor, reativação estendida para conta.
- **Banco**: `revenue_opportunities`, `revenue_recovery_events`.
- **IA**: agente de recovery com promessas vigiadas pela promise-table por conta.
- **Aceite**: painel mostra R$ em risco; re-pedido atrasado gera oportunidade e follow-up com resultado medido.
- **Dependências**: Fase 4 (orders vivos por algumas semanas de dados). **Rollback**: detector desligável (cron knob).

## FASE 9 — Integração ERPNext
- **Objetivo**: pedido nativo espelha para o ERP; estoque/preço consultados.
- **Arquivos**: `lib/erp/` + adapter ERPNext, wizard de conexão, reconciliador.
- **Banco**: `erp_connections` (ou providers novos no CHECK), sync_ledger já da Fase 4.
- **APIs**: webhook inbound de ERP (HMAC por conexão).
- **Testes**: invariante de idempotência de sync; e2e com ERPNext local (docker).
- **Aceite**: pedido criado na conversa aparece no ERPNext com número; status de entrega volta para a conta/conversa.
- **Dependências**: Fase 4 + piloto estável. **Rollback**: conexão desativável; pedidos continuam nativos.

## FASE 10 — Hardening de produção
- **Objetivo**: suportar pilotos pagos.
- **Conteúdo**: retenção/partição para order_events e llm_calls, observabilidade de pedido (SLO), carga do drain, revisão de limites de API, ensaio automatizado de update em VPS (o caso U6 ainda aberto), vps-fresh-onboarding com modo B2B.
- **Aceite**: 5 checks verdes + atualização automatizada numa VPS real de teste.

## FASE 11 — Cliente piloto
- **Objetivo**: 1 distribuidor real.
- **Conteúdo**: onboarding assistido (kit), carga de catálogo, lista de preços, ERP conectado, meta de pedidos/semana, loop de propostas (flywheel) ligado.
- **Aceite**: critério definido com o dono (ex.: N pedidos conversacionais/semana com <X% de correção humana).

---

**Ordem deliberada**: fundação antes de dinheiro (F1); contas antes de preço (F2→F3); preço antes de pedido (F3→F4) — porque invariante de pedido depende de resolução de preço; agentes depois do engine (F5) para não acoplar IA a schema instável; ERP por último (F9) porque é externo e o pedido nativo tem valor próprio.
