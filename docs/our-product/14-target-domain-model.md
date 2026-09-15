---
type: our-product/phase-0-audit
doc: 14-target-domain-model
status: final
created: 2026-09-14
type_note: Modelo CONCEITUAL (Fase 0 não implementa migrations). Nomes de tabela propostos são sugestão; reusos marcados.
---

# 14 — Modelo de domínio alvo (conceitual)

## 1. Diagrama de relações (ASCII)

```
Tenant (organizations) ──< User (auth.users) via Staff (user_organizations: role)
        │
        ├──< Integration (tenant_integrations / erp_connections*)
        ├──< PriceList* ──< PriceListItem* >── Product (catalog_products, reuso)
        │        ▲
        │        │(price_list_id)
        ├──< Account* ──< AccountContact* >── Contact (contacts, reuso)
        │      │  (condições, prazo, limite, MOQ, rep=owner_user_id, price_list_id)
        │      ├──< AccountPrice* >── Product
        │      │
        │      └──< SalesOrder (orders, ADAPTADO: origin=manual|erp|nuvemshop)
        │               │ (status, fulfillment, total_cents, currency, moeda de nascimento)
        │               ├──< SalesOrderItem* >── Product (sku snapshot, qty, uom*, unit_price, discount, total)
        │               ├──< OrderEvent* (append-only: created/confirmed/amended/cancelled/synced/failed)
        │               ├──< Delivery (fulfillment_status + tracking_code existentes; ERP alimenta)
        │               └──> ErpSyncLedger* (provider, external_id, estado, última tentativa)
        │
        ├──< ChannelIdentity (contacts.wa_identity, reuso) ──< Conversation (reuso) ──< Message (reuso)
        │
        ├──< SalesRep (= user com papel; atribuição por Account; métricas existentes reusadas)
        ├──< HumanHandoff (contacts.force_human, demandas — reuso)
        ├──< Notification (agent_inbox_items, push — reuso)
        ├──< RevenueOpportunity* (conta×sinal: re-pedido atrasado, pedido travado, esfriado c/ valor)
        ├──< RevenueRecoveryEvent* (oportunidade→ação→resultado; irmão de crm_lead_reactivations)
        └──< AuditEvent (api_audit_log + event_log + order_events — reuso)
```
\* = **construção nova**. Sem asterisco = reuso da tabela existente (evidência nos docs 03/06).

## 2. Entidade por entidade

| Entidade | Origem | Relações-chave | Notas de desenho (RECOMENDAÇÃO) |
|---|---|---|---|
| Tenant | `organizations` (reuso) | raiz de tudo | `settings` ganha bloco `b2b` (MOQ default, política de crédito) |
| User/Staff | `auth.users` + `user_organizations` (reuso) | role 4 níveis | — |
| Customer Account | **`accounts`** (nova) | owner (rep), price_list, condições | pessoa jurídica; cnpj/cpf opcional com mesma criptografia do contato; contacts ganha `account_id` nullable (contato pode existir sem conta no B2C) |
| Customer Contact | `contacts` (reuso) | account_id novo | merge/identidade já existentes |
| Channel Identity | `contacts.wa_identity` (reuso) | → contact → conversation | já resolve phone/lid |
| Conversation/Message | reuso | contact, session | saída única + before-send recebem gate de pedido |
| Product/SKU | `catalog_products` (reuso) | ← items, ← prices | `unidade` nova; taxonomia só se demanda real |
| Price List | **`price_lists` + `price_list_items`** (novas) | tenant→lista→item→produto | versão vigente por validade (padrão version pointers do repo) |
| Customer Price | **`account_prices`** (nova) ou `accounts.price_list_id` | account→produto | override pontual vence lista |
| Warehouse/Inventory | consulta ERP on-demand (Fase 9); `catalog_products.quantidade` até lá | — | sem estoque local multi-CD no MVP |
| Sales Order | `orders` **ADAPTADO** | account (hoje contact_id), items, events, ledger | migration: origin (manual/erp/nuvemshop), ampliar CHECK, manter unique 3-col |
| Sales Order Item | **`order_items`** (nova) | order→product | snapshot de sku/nome/preço no item (pedido é fato histórico) |
| Order Event | **`order_events`** (nova, append-only) | order | alimenta métricas e ERP webhook; nunca UPDATE |
| Order Modification | order_events kind=amendment + delta jsonb | — | DIRC: total é CALCULADO dos itens, nunca campo duplicado |
| Delivery | colunas existentes + eventos ERP | — | — |
| Sales Representative | `accounts.owner_user_id` (novo vínculo) | — | rep já é user; métricas por atendente reusadas |
| Human Handoff | reuso completo | — | — |
| Notification | reuso completo | — | novos kinds (order_* ) seguem padrão dedup |
| Revenue Opportunity | **`revenue_opportunities`** (nova, derivada) | account/order/silêncio | calculada por detector (worker/cron), não por trigger |
| Revenue Recovery Event | **`revenue_recovery_events`** (nova) | opportunity→ação→outcome | reusa motor de follow-up para execução |
| Integration | `tenant_integrations`/`erp_connections` (ADAPT CHECK) | credenciais cifradas | doc 10 |
| Audit Event | reuso + order_events | — | append-only herdado |

## 3. Invariantes de domínio que o modelo carrega (futuros testes/invariantes)

1. Pedido confirmado tem ≥1 item; item tem produto ativo ou produto com snapshot válido.
2. total = Σ itens (calculado, auditável) — nunca diverge.
3. Emenda cria OrderEvent; itens confirmados não são UPDATEados (delta por evento).
4. Preço resolvido = override de conta > item de lista vigente > preço de catálogo; a resolução é registrada no item (moeda da origem).
5. Pedido só confirma com estoque/preço/MOQ válidos OU escala humano (política por org).
6. Idempotência: (org, origin, external_id) único; re-entrega idempotente.
7. Toda transição emite OrderEvent no mesmo commit (outbox).
8. RLS em toda tabela nova com a varredura de catálogo como gate.
