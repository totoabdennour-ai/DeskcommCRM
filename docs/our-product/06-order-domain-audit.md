---
type: our-product/phase-0-audit
doc: 06-order-domain-audit
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d
evidence: supabase/baseline.sql, lib/catalogo/, lib/nuvemshop/, lib/mcp/tools/comercio.ts, app/app/products/
---

# 06 — Auditoria do domínio de pedidos/vendas

## 1. O que existe hoje (CONFIRMADO)

**A coluna vertebral de comércio é intencionalmente oca.** Medido por varredura exaustiva:

- **`orders` (espelho header-only) tem ZERO escritores em produção.** O sync da Nuvemshop não existe — o header da migration 0204 afirma isso como medida ("o sync da Nuvemshop ganhar o escritor que hoje lhe falta"), e o grep confirma: únicos writers são seed E2E. Os webhooks de pedido da Nuvemshop são verificados, logados e emitidos em `event_log` (`nuvemshop.order_created` etc.) **e nenhum worker consome**.
- **`nuvemshop_products` também tem zero escritores** — o consumidor de RAG (`nuvemshop.product_synced`) está pronto e faminto, o emissor não existe.
- **Leitores de `orders` (4) já vivos e degradando graciosamente**: MCP `crm_list_contact_orders`, painel do inbox (crm-summary, top 3), export LGPD (preserva totais na redact), stats admin. UI: seção "Sem pedidos." no painel CRM do inbox; **não existe página de pedidos**.
- **`catalog_products` (0204) é o único objeto de comércio vivo**: SKU (`codigo` único), preco_cents, **custo_cents sem leitor**, controla_estoque/quantidade (só filtro de visibilidade do agente), origem manual/planilha/nuvemshop, importador CSV idempotente por (org, codigo), UI completa, API (3 rotas, moeda da org), tool MCP `crm_search_products` com algoritmo de busca token-wise (palavras fuzzy/Levenshtein, **números como hard-filter com tolerância de sufixo** — construído contra corpus real de 20k títulos onde `ilike` falhava), avisos de empate/relaxamento para o agente confirmar.
- **Pricing**: inexistente. `promise_table` (guardrail de IA: minPriceCents, maxDiscountPercent, maxInstallments) é o único controle, e é de **mensagem de saída**, não de transação. `lib/money.ts` é a fonte de formatação/parse (BRL/MXN/USD, zero-decimal). Moeda por org (0208) já pensada para orders manterem moeda de nascimento.
- **Vinculação conversa→comércio**: `garantirLeadDaConversa` nasce no pipeline de ingest; `crm_lead_links.target_kind='order'` existe no CHECK **e em nenhum escritor** (só 'appointment' é escrito).
- **Automações**: 7 ações (`add-tag`, `assign-owner`, `create-or-move-lead`, `call-webhook`, `send-whatsapp`, `start-message-flow`, `send-ai-message`) — **nenhuma de comércio**.
- **Métricas de receita**: o valor mandado ao Meta CAPI (Purchase) é `crm_leads.value_cents` — orders é vazio, então a "receita" do funil é valor de lead digitado.
- **"Propostas"**: são 3 coisas, nenhuma é orçamento de venda — flywheel (auto-aprimoramento), reativação (win-back), sugestão de dado de contato. Não há cotação/orçamento em lugar nenhum.

## 2. Comparação com o domínio B2B required (distribuição/atacado)

| Conceito | Existe | Reusável | Precisa extensão | Precisa ser construído | Evidência |
|---|---|---|---|---|---|
| Customer account (empresa) | ❌ | — | `contacts.account_id` | tabela `accounts` (condições, prazo, limite) | `contacts` = pessoa física (baseline:1324) |
| Product | 🟡 | `catalog_products` | taxonomia se necessária | — | 0204 |
| SKU | ✅ | `codigo` | — | — | unique por org |
| Variant | ❌ (deliberado) | filosofia 1-linha-por-SKU | — | manter flat | header 0204 |
| Unit of measure | ❌ | — | coluna `unidade` + conversão p/ itens | — | nada |
| Price list | ❌ | — | — | `price_lists` + itens | nada |
| Customer price | ❌ | — | — | `account_prices` ou preço na lista | nada |
| Discount | 🟡 | guardrail da tabela de promessas | política por conta | desconto por linha | promise/table.ts |
| Minimum order | ❌ | — | — | campo na conta/lista | nada |
| Stock | 🟡 | quantidade + controla_estoque | decremento/reserva | — | 0204; zero writes |
| Warehouse | ❌ | — | — | fase tardia | nada |
| Credit limit / prazo | ❌ | — | — | campos na conta + gate no order engine | nada |
| Sales order | ❌ | **tabela `orders` existe** (contrato de espelho) | CHECK ganha origem manual/internal | escritor nativo + lifecycle | baseline:1696 |
| Order items | ❌ | — | — | `order_items` | nada |
| Order amendment/cancellation | ❌ | status enum tem cancelled/refunded (nunca setados) | — | `order_events` + fluxo de emenda | — |
| Backorder / substitution | ❌ | avisos de empate/relaxamento do agente (conversacional) | — | relation de substituto se exigido | comercio.ts:111 |
| Delivery | 🟡 | fulfillment_status + tracking_code (nunca populados) | espelho ERP | — | baseline |
| Sales rep | 🟡 | owner no lead | atribuição conta→rep | — | 0070 |

## 3. O que isso significa (leitura de arquiteto)

1. **A mesa está posta**: `orders`, `crm_lead_links('order')`, `tenant_integrations(vtex|shopify)`, `catalog_products`, `custo_cents`, moeda por org, leitores de pedido vivos — o schema **antecipou** comércio e parou um passo antes do escritor. A transformação B2B é aditiva, não invasiva.
2. **O agente é o canal de venda de facto**: `crm_search_products` + `crm_list_contact_orders` + promise-table já formam o "garçom". O order agent nasce estendendo ESTES pontos, respeitando o contrato congelado de nomes de tools.
3. **Funil já fala "Pedido"**: o vocabulary default do pipeline renomeia deal→Pedido/won→Pago — a semântica de produto para distribuição já foi absorvida pela UI.
4. **Maior risco de desenho**: decidir se `orders` vira pedido nativo (mudança de CHECK + origem) ou se nasce `sales_orders` novo. RECOMENDAÇÃO desta auditoria: **reusar `orders`** (menos tabelas, leitores já existem, LGPD/admin já contam com ele), com migration que (a) dedup/verifica dados, (b) adiciona `origin` + ampla o CHECK, (c) cria `order_items` + `order_events`. Alternativa (tabela nova) documentada no doc 14 para o dono decidir.
5. **Nuvemshop**: o integration é OAuth completo + webhooks verificados, mas **sem sync de produto/pedido** — para o alvo B2B, Nuvemshop é caso B2C de referência; o esforço real vai para ERP (doc 10).
