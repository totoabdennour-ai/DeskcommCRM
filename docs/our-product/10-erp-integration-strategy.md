---
type: our-product/phase-0-audit
doc: 10-erp-integration-strategy
status: final
created: 2026-09-14
type_note: RECOMENDAÇÃO de desenho — nada implementado na Fase 0
---

# 10 — Estratégia de integração com ERP (ERPNext como sistema externo)

## 1. Decisão-quadro (RECOMENDAÇÃO)

**ERPNext não é forkado e não é dependência em tempo de execução.** A arquitetura-alvo coloca um **ERP Gateway** dentro do monólito modular, atrás de uma interface única:

```
Order Engine (nosso domínio nativo, Postgres)
      │ operações de domínio (criar pedido, consultar preço/estoque, status)
      ▼
ErpAdapter (interface TypeScript única, por org: erp_connections.provider)
      ├── ERPNextAdapter   (REST/RPC do ERPNext, api_key/secret)
      ├── OdooAdapter      (XML-RPC/JSON-RPC)      [fase tardia]
      └── CustomErpAdapter (webhook/HTTP genérico) [fase tardia]
```

O ERP é **sistema de registro operacional** (estoque real, faturamento, fiscal); **nosso banco é o sistema de registro comercial** (conta, preço acordado, pedido conversacional, receita em risco). O pedido nasce AQUI, o ERP o espelha.

## 2. Operações que a interface precisa expor (do pedido do dono + evidência de gaps)

| Operação | Direção | Frequência | Idempotência | Precedente no repo |
|---|---|---|---|---|
| Customer sync (conta ↔ customer ERP) | ours→ERP + ERP→ours | on-demand + delta | `external_id` + unique (org, provider, external_id) — **padrão já existe em `orders`** | `tenant_integrations`, `fn_encrypt_oauth` |
| Product/SKU sync | ERP→ours | delta agendado (cron) | upsert por (org, external_id) — padrão `nuvemshop_products` (que hoje tem leitor-pronto/escritor-ausente) | `sync-model-catalog` (cron de catálogo com saneamento) |
| Inventory lookup | ERP→ours | **query on-demand no turno do agente** (nunca espelho de alta frequência no MVP) | n/a (leitura) | `crm_search_products` (cache curto) |
| Pricing lookup | ERP→ours | on-demand | n/a | `crm_list_contact_orders` |
| Sales order create | ours→ERP | por pedido | **`idempotency_key` do pedido** no payload; capturar 23505/erro-duplicado → idempotente 200 | `send_ledger` (intenção exactly-once, entrega at-least-once) |
| Order update/amend | ours→ERP | por emenda | versionamento por `order_events` seq | playbook/version pointers (nunca UPDATE de registro) |
| Delivery/invoice status | ERP→ours | webhook do ERP quando possível; **polling delta** como fallback | unique (org, provider, external_id) por evento | `webhook_events_log` + `emit_event` |
| Error recovery | — | — | sync_ledger persistente com estados (pending/ok/failed/superseded) + reconciliador cron + dead-letter com alerta | `failJob` → `agent_inbox_items` (job_queue faz isso; event_log não) |

## 3. Regras de desenho derivadas da auditoria (evidência)

1. **Síncrono só o que o turno do agente precisa** (estoque/preço = leitura com cache curto); **assíncrono tudo que escreve** (pedido vai por fila `job_queue` com drainer dedicado — doc 07 §6).
2. **Outbox transacional**: insert do pedido + evento `order.created` no mesmo commit (padrão trigger/`completeJob(inSameCommit)` já provado). ERP ack vira evento de reconciliação.
3. **Saga de compensação mínima**: se o ERP rejeita o pedido já confirmado ao cliente, o estado vira `sync_failed` com item crítico na Central + ordem de correção humana — não há rollback mágico; a conversa é a compensação (o agente informa). Explicitar isso como invariant, não como bug.
4. **Credenciais por org** em `erp_connections` (ou reusar `tenant_integrations` com novos providers no CHECK) — sempre cifradas, nunca em query string, plaintext nunca persistido (padrão `api_tokens`/`ai_provider_credentials`).
5. **Multi-tenancy do adapter**: toda operação carrega org do contexto confiável; o adapter nunca aceita org por payload externo.
6. **Rate limits e retries**: backoff exponencial com cap (padrão `failJob`), janela de cortesia para não derrubar ERP do cliente, circuit breaker por conexão (precedente: `health/circuit.ts` das sessões).

## 4. Por que NÃO n8n como camada de integração (ver doc 11-12)

A mesma auditoria de confiabilidade que valida o `job_queue` para pedidos mostra que n8n adicionaria: um segundo barramento sem os primitivos de dedup/ledger/advisory-lock, um banco/graph próprio para operar, e um ponto de falha fora do alcance dos testes de invariante do repo. O custo de integrar n8n supera o custo de escrever o adapter (a interface é pequena: ~8 operações). n8n permanece **ferramenta opcional do operador** (webhooks de saída já existem com SSRF guard) — nunca parte do core.

## 5. Fases (recomendação, detalhada no doc 16)

Fase 9 (ERPNext) só depois de: pedido nativo com order_events (Fase 4), pricing (Fase 3), e sync_ledger (Fase 1 de fundação). ERPNextAdapter é o primeiro; Odoo/Custom ficam para demanda real.
