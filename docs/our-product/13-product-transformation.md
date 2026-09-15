---
type: our-product/phase-0-audit
doc: 13-product-transformation
status: final
created: 2026-09-14
---

# 13 — Transformação de produto: DeskcommCRM → AI Revenue & Order Operations OS

## 1. Identidade (o que muda na promessa)

- **Hoje** (VISION.md): "sistema operacional de vendas com agentes de IA, para qualquer negócio que vende conversando" — multi-nicho, categoria âncora "alternativa open source a Kommo/Octadesk".
- **Alvo** (este plano): **AI Revenue & Order Operations OS** para **B2B atacado/distribuição** — a camada de IA que opera cliente, pedido, operação e recuperação de receita sobre ERPs existentes. Nicho inicial único; os nichos atuais (clínica, imobiliária…) continuam servidos pelo mesmo core — o modo B2B é um vertical novo, não uma reescrita.

## 2. Tabela de transformação (OLD CONCEPT → NEW CONCEPT → TRANSFORMATION REQUIRED)

| OLD CONCEPT | NEW CONCEPT | TRANSFORMAÇÃO REQUERIDA |
|---|---|---|
| CRM genérico (contato = pessoa) | **Operação de contas B2B** (empresa com condições, prazo, limite, rep) | tabela `accounts` + vínculo contato↔conta + pricing por conta (Fase 2-3) |
| "Venda" = linha no funil com value_cents digitado | **Pedido de venda nativo** com itens, estados, emendas e eventos | Order Engine (Fase 4): orders ganha origem, nasce order_items/order_events |
| Produto = SKU flat para o agente citar preço | **Inteligência de catálogo** (lista de preços, preço por conta, MOQ, disponibilidade consultada no ERP) | Pricing (Fase 3) + extensão do catálogo + lookup ERP |
| Conversa = atendimento | **Conversa de receita** (cada turno pode nascer/avançar/recuperar um pedido) | Order Agent com extração estruturada (Fase 5) + guardrail de confirmação |
| IA = atendente que qualifica e move lead | **Agentes operadores**: Sales, **Order**, Support, **Revenue Recovery** | Extensões do agent-engine com tools novas e módulo próprio (Fase 5) |
| Funil com "vazamento" medido por temperatura | **Revenue leakage** medido em dinheiro (pedido perdido, re-pedido atrasado, carrinho de WhatsApp esfriado) | detector monetário sobre orders×silêncio×estágio (Fase 8) |
| Follow-up de conversa esfriada | **Recuperação de receita** (win-back de conta, re-pedido cíclico, pedido travado no ERP) | Recovery events + reativação estendida (Fase 8) |
| Integração = Nuvemshop (B2C espelho oco) | **ERP é o sistema operacional do cliente** (ERPNext primeiro) | ERP Gateway com adapter + sync ledger (Fase 9, doc 10) |
| Instalável em VPS para qualquer nicho | **Mesmo self-host**, vertical B2B como template de onboarding | template de pipeline/vocabulário B2B + wizard de conexão ERP |
| MCP = ferramentas internas do agente | MCP continua a porta para agentes externos operarem pedidos | novas tools `crm_*_order` (nome congelado desde o dia 1) |

## 3. O que NÃO muda (âncoras do produto atual — evidência nos docs 01-09)

Multi-tenant RLS-first · self-host como monetização · WhatsApp como canal primário · LGPD nativa · guardrails como produto · kit de 1 comando · open source MIT. A transformação é **aditiva**: a auditoria (docs 03, 06, 12) mostra que schema, canais e agente anteciparam o comércio e pararam um passo antes do escritor de pedidos.

## 4. Riscos de transformação de produto (resumo; completo no doc 17)

1. **Escopo**: o multi-nicho atual é identidade pública; posicionar o B2B sem matar os outros verticais (RECOMENDAÇÃO: "modo B2B/distribuição" como vertical, não como pivot).
2. **Confiança no pedido conversacional**: erro de IA em pedido = dinheiro; o desenho precisa de confirmação explícita do cliente (ou gate humano configurável) antes de confirmar — já existe o padrão (promise-table vetando promessa; before-send).
3. **ERP do cliente é incontrolável**: pilotos falham por ERP ruim, não por CRM — o sync_ledger + estados visíveis (doc 10) são a resposta de produto.
