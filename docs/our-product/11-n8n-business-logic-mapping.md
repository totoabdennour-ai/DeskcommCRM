---
type: our-product/phase-0-audit
doc: 11-n8n-business-logic-mapping
status: final
created: 2026-09-14
evidence_note: "Nenhum workflow n8n existe neste repositório (verificado: zero arquivos, zero deps). A coluna N8N BEHAVIOR vem da descrição do dono; OPEN QUESTION onde o detalhe do workflow muda o requisito."
---

# 11 — Tradução do protótipo n8n → requisitos do produto

> Método: **não recriar workflows** — traduzir comportamento em invariantes de negócio sobre o
> domínio-alvo. Onde o comportamento n8n não está especificado, marcado **OPEN QUESTION** para o
> dono exportar o workflow correspondente antes da fase que o consome.

| # | N8N BEHAVIOR | → BUSINESS INVARIANT | → TARGET DOMAIN | → TARGET SERVICE | → DATABASE REQUIREMENT | → API REQUIREMENT | → TEST REQUIREMENT |
|---|---|---|---|---|---|---|---|
| 1 | **Customer resolver** (mensageiro anônimo → cliente conhecido) | Um humano é um contato único por tenant; identidade de canal mapeia deterministicamente para contato; merge é operação auditable | `accounts` + `contacts` + channel identity | `lib/channels/pos-entrada.ts` (já faz: RPCs atômicos `fn_upsert_wa_contact`) | `contacts.wa_identity` gerado; `accounts.account_id`; merge tombstone (`is_merged_into`) | nenhuma nova — ingest resolve | invariante: 2 tenants, mesmo telefone → 2 contatos; merge reponta FKs (já existe `fn_mesclar_contatos`) |
| 2 | **Channel identity** | O par (org, provider, external_id) identifica a mensagem exatamente uma vez | channel_sessions/conversations/messages | `lib/waha/ingest.ts` (HMAC → normalização → RPCs) | unique DEFERRABLE (org, external_id); webhook_events_log | webhooks com HMAC timing-safe | dedup 23505; eco fromMe não duplica (já testado) |
| 3 | **Order create** (a partir da conversa) | Pedido rascunho → confirmação → pedido confirmado, com itens imutáveis após confirmação (emenda = evento novo) | `orders` (origem manual) + **`order_items`** + **`order_events`** | **Order Engine** (novo, Fase 4) sobre `job_queue` | outbox transacional: pedido+evento no mesmo commit; unique (org, provider='manual', external_id) para re-entrega | `POST /api/v1/orders` com `Idempotency-Key` honrado server-side; tool MCP `crm_create_order` (nome novo — contrato congelado) | invariante: idempotência por chave; invariante: item sem preço resolvido não confirma; unit do schema Zod do rascunho |
| 4 | **Order lifecycle** | Estados só avançam por transição válida; toda transição emite evento consumível | `order_events` append-only + status CHECK | Order Engine | event sourcing leve (padrão event_log já no banco) | webhook out para ERP (doc 10) | invariante de transição (matriz de estados); handler idempotente |
| 5 | **Order modification** | Emenda cria delta auditável; valor recalculado nunca diverge dos itens | order_items + order_events (kind=amendment) | Order Engine | itens versionados por evento; totais derivados (DIRC: calcular, não duplicar) | `PATCH /api/v1/orders/[id]` | invariante: soma(itens) == total; diff visível na timeline |
| 6 | **Idempotency** | Re-entrega não cria segundo pedido | idempotency_keys + unique constraints | todos os POSTs de criação de dinheiro | `idempotency_keys` (TTL 24h, request_hash) — existe, só 4 rotas usam | adotar em `orders` | 23505→200 idempotente (padrão `fn_create_tenant_with_owner`) |
| 7 | **Audit/event logging** | Toda mutação de dinheiro audita; trigger nunca faz HTTP | api_audit_log + event_log + order_events | `lib/audit/` (fire-and-forget) | append-only por GRANT (já existe) | — | guard AST "audita quando há efeito" estendido às rotas de pedido |
| 8 | **Human handoff** | IA nunca retoma após handoff; aviso ao lead antes do silêncio | contacts.force_human + demandas + agent_inbox_items | `lib/agent-engine/human-handoff.ts` (JÁ COMPLETO) | existente | — | já coberto (golden + unit); reusar |
| 9 | **AI escalation** | Gatilho determinístico antes do modelo; budget-block escolta para humano | já existe (G1-G4, escort) | `runAgentTurn` | existente | — | já coberto |
| 10 | **Notifications** | Evento → Central → push, dedupado por episódio | agent_inbox_items + web push | `lib/notifications/` (JÁ COMPLETO) | existente | — | push handler idempotente (já testado) |
| 11 | **Retry/failure recovery** | Retry com backoff; poison → dead **com alerta**; ERP sync tem ledger | job_queue (com alerta) + sync_ledger (novo, irmão do send_ledger) | Order Engine/ERP Gateway | `sync_ledger` (org, order, provider, estado) | — | invariante: dead de pedido gera item crítico na Central |

**Resumo**: 6 dos 11 comportamentos já existem em código melhor do que qualquer workflow n8n faria (1, 2, 8, 9, 10 e metade do 7). O n8n prototype prova a **demanda e o desenho funcional**; o que falta construir (3, 4, 5, 6-server-side, 11-ledger) concentra-se no Order Engine — e cada linha acima já tem o precedente de padrão no repo.

**OPEN QUESTIONS para o dono (blocantes para a Fase 2-4):**
1. O workflow de order create do n8n valida MOQ/crédito? Com que comportamento de falha (rejeita / confirma parcial / escala humano)?
2. Há regra de **substituição de item** no protótipo (SKU esgotado → alternativa)?
3. O resolver n8n usava chave de identidade além de telefone (CPF? documento?)?
4. Como o protótipo tratava **preço por cliente** (tabela fixa? fórmula? manual pelo atendente)?
5. Existia **janela de corte de pedido** (horário/fechamento de dia) que precise virar invariante?
