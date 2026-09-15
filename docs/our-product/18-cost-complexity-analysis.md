---
type: our-product/phase-0-audit
doc: 18-cost-complexity-analysis
status: final
created: 2026-09-14
---

# 18 — Análise de custo / complexidade

## 1. Onde o esforço de engenharia se minimiza (evidência de reuso)

O maior ativo é o que NÃO precisa construir: **18 dos ~30 subsistemas são KEEP** (doc 12) — plataforma multi-tenant com RLS provada em CI, canais WhatsApp com anti-ban e HMAC, agent-engine com guardrails/fila/orçamento, LGPD completa, self-host kit, white-label. Estimativa de proporção: ~70% do produto-alvo já existe em código (INFERIDO qualitativamente da matriz; o BUILD real concentra-se em 4 módulos: Order Engine, Pricing, Accounts, ERP Gateway).

Alavancas concretas:
- **Order Agent reusa 3 interfaces prontas** (`crm_search_products`, `crm_list_contact_orders`, promise-table) — o custo do agente é o schema de extração + confirmação, não a infraestrutura.
- **`catalog_products` já tem busca validada em corpus real** (busca token-wise; não gastar em busca vetorial para SKU).
- **Idempotência/outbox/ledger têm precedentes de arquivo** (`fn_create_tenant_with_owner`, `send_ledger`, `completeJob(inSameCommit)`) — copiar padrão, não inventar.
- **Nuvemshop product sync** é a ponte mais barata de RAG de catálogo (consumidor pronto, falta emissor ~S).

## 2. Tokens de IA (o custo operacional que escala com uso)

- **Cache de prefixo já implementado** (prefixo byte-determinístico + `LLM_CACHE_TTL`) — o prompt B2B crescente não multiplica custo se mantiver o prefixo estável (regra de desenho: contexto por conta vai no SUFFIX, não no prefixo).
- **Resolução de preço/estoque determinística (SQL), não LLM** — o agente chama tool; o cálculo é banco. Menos tokens, mais correção.
- **Extração de pedido**: 1 chamada `generateObject` por turno com sinal de pedido (gated por classificador barato), não por turno.
- **Budget por org já enforcement** (block com carência) — piloto paga-se com teto; ponto cego: custo NULL de modelos não-Claude (Fase 1: estender `pricing.ts`).
- Compaction + poda de tool results já existem — sessões longas de distribuição (pedidos grandes) não explodem contexto.

## 3. Infraestrutura

- **Zero serviço novo no compose**: order engine roda no `worker` e no `app` existentes; ERP é chamado por egress. Custo marginal de infra ≈ zero.
- ERP polling com cache curto (TTL no Redis efêmero) em vez de espelho contínuo — menos carga no ERP do cliente (que é produção do cliente).
- VPS recomendada continua a mesma classe (4GB já é o piso do kit); order events não muda isso antes de volume real.

## 4. Complexidade de banco (minimizada por decisões já tomadas)

- Reusar `orders` (1 tabela adaptada) em vez de tabela nova + pontes: economiza migration de leitores (LGPD/admin/inbox/MCP já apontam para ela).
- DIRC aplicado: total calculado (não duplicado), preço resolvido registrado no item (referenciar, não sincronizar), eventos append-only (não estado mutável paralelo).
- Sem partição no MVP; retenção estendida na Fase 10 quando a evidência de volume pedir.

## 5. Manutenção / duplicação

- **Módulos novos fora do god-file** evitam agravar o maior ponto de manutenção atual (inbound-turn).
- **REMOVE planejado do caminho legado de IA** (dispatcher/ai-response-worker) elimina 2 caminhos por feature de IA — economia contínua.
- **Gate de service-role e dead-letter com alerta** reduzem a classe de bug mais cara (vazamento silencioso) antes de o domínio de dinheiro multiplicar os handlers.
- Testes: padrão do repo (invariante por regra de domínio + e2e visual) já paga-se; cada invariante do doc 14 é 1 arquivo no formato existente.

## 6. Resumo de custo por fase (ordem de grandeza, 1 eng. sênior + IA)

| Fase | Esforço | Observação |
|---|---|---|
| 1 Fundação | S-M | ~10 itens pequenos e independentes |
| 2 Contas | M | tabela + telas + RLS |
| 3 Pricing | M-L | a peça de regra de negócio mais densa |
| 4 Order Engine | L | o coração; invariantes pesam |
| 5 Agentes | M | sobre base pronta |
| 6 Multimodal | M | cap/visão/parser |
| 7 Operações humanas | M | telas |
| 8 Recovery | M | detector + execução reusada |
| 9 ERPNext | L | externo; adapter clean-room |
| 10 Hardening | M | retenção/SLO/ensaio de update |
| 11 Piloto | — | conduzido com o cliente |
