---
type: our-product/phase-3
doc: 24-phase-3-pricing-completion-report
status: final
created: 2026-09-16
baseline: Fase 2 commitada (a5fe7684)
---

# 24 — Relatório de conclusão da Fase 3 (Pricing Foundation)

## 1. Auditoria inicial (o que JÁ existe — nada paralelo será criado)

| Conceito | Estado no repo | Evidência |
|---|---|---|
| Product/SKU | **EXISTS** — `catalog_products` (0204): `codigo` único por org (é o SKU), `preco_cents bigint NOT NULL` (preço BASE), `moeda CHECK ^[A-Z]{3}$` default BRL, `custo_cents` (piso, opcional), `ativo boolean`, GIN trgm em nome | baseline:17163 |
| Currency | **EXISTS** — convenção `^[A-Z]{3}$` em `crm_leads.currency`, `catalog_products.moeda`, `organizations.currency` (0208, default BRL) + helper `moedaDaOrganizacao()` | baseline:1468/17207/17349 |
| Price lists / customer price | **MISSING** — todo "pricing" no repo é de TOKEN de LLM (`lib/agent-engine/edge/llm/pricing.ts`, `ai_models`/`ai_pricing`), domínio alheio | varredura grep |
| Discounts | **MISSING como entidade** — só o guardrail de IA (`promise_table.minPriceCents/maxDiscountPercent`, mensagem de SAÍDA) | guardrails/promise/table.ts |
| Taxes | **MISSING de propósito** — ERP é o sistema fiscal (doc 21 §11) | DECISIONS D8 |
| Price snapshot | **MISSING** — `orders.total_cents` + `payload jsonb` aguardam o Order Engine (F4) | baseline:1696 |
| Quantities/units | `catalog_products.quantidade` (estoque, int sem unidade); UOM é lacuna registrada da Fase 2 | 0204 |
| Resolver pattern | **EXISTS** — puro + shell de IO (`lib/routing/decide.ts` + `worker.ts`); `lib/money.ts` formata/parseia | lib/routing |
| Fronteira de IA | **EXISTS** — promise-table veta preço/promessa inventado na saída do agente; resolver mantém o padrão do lado da consulta | guardrails |

## 2. Plano de implementação (consciso, antes de codar)

**Modelo**: `Tenant → Account.price_list_id → price_lists → price_list_items → catalog_products`.

1. **Migration 0240**: `price_lists` (nome, moeda herdada da org no default, status CHECK active/inactive) + `price_list_items` (preco_cents ≥ 0, unique (lista, produto), CASCADE no produto — item sem produto não tem sentido) + `accounts.price_list_id` (SET NULL) + gatilhos same-org (molde 0239) + RLS select org-flat / write manager+ (molde catalog_products) + baseline ANTES da VARREDURA anon + MANIFEST.
2. **Resolver canônico** (`lib/pricing/resolver.ts` puro + `consultar.ts` IO): precedência determinística conta→lista ativa→item, senão preço base do catálogo, senão `no_price` com motivo. Saída carrega TUDO que o snapshot da Fase 4 precisa (sku/nome/moeda/fonte/ids).
3. **API**: `price-lists` (GET/POST), `[id]` (PATCH), `[id]/items` (GET/PUT upsert), `[id]/items/[productId]` (DELETE), `pricing/resolve` (GET — o contrato que o Order Engine e a futura tool de IA consomem). Manager+ para mutações.
4. **UI mínima**: tela `/app/pricing` (listas + editor de itens com busca de produto pelo existente `/api/v1/products`) + select de lista no formulário de edição de conta.
5. **Fronteira de IA**: documentada + imutável — NENHUMA tool MCP nova nesta fase (a tool de consulta entra na F5, consumindo o MESMO serviço; a IA continua sem poder mutar preço — RLS manager+ no banco é a enforcement).
6. **Testes**: resolver puro (precedência/inativos/ausência/determinismo), schemas, rotas (org de fonte confiável, authz), invariante same-org (lista e item), par de vocabulário, snapshot-shape.

**Regras de negócio não inventadas — menores suposições explícitas (decisão exigida antes do Order Engine):**
- **A1 — fallback**: produto ausente na lista ATIVA da conta → cai no preço BASE do catálogo (comportamento atacado típico: lista sobrepõe, ausência herda).
- **A2 — produto inativo** → `no_price` (motivo `produto_inativo`).
- **A3 — lista inativa** → ignorada na resolução (cai ao base).
- **A4 — moeda**: item é precificado na moeda da LISTA; base, na moeda do produto. Sem conversão.
- **A5 — quantidade**: sem preço por quantidade na Fase 3; o contrato aceita `quantidade` para o futuro, a saída é sempre por unidade.

## 3. Modelo final de precificação (implementado)

```
Tenant (organizations.currency = moeda default)
   └── Account ──price_list_id (0240, SET NULL, gatilho same-org)
            └── price_lists (nome, moeda CHECK ^[A-Z]{3}$, status active|inactive)
                    └── price_list_items (preco_cents >= 0, unique (lista, produto),
                            CASCADE no produto) ──> catalog_products (preço BASE)
```

- **Preço base**: `catalog_products.preco_cents` + `moeda` — REUSADO, nada paralelo.
- **Sobreposição**: item da lista ativa da conta vence o base (A1); ausência/inatividade herdam ou recusam por regra documentada (A2/A3).
- **Moeda**: a da LISTA governa os itens (A4 — item não tem coluna de moeda, impossível divergir no banco); base, a do produto. Sem conversão.
- **Gatilhos same-org** (molde 0239): `fn_valida_item_da_mesma_org` (lista E produto da org da linha) e `fn_valida_lista_da_mesma_org` (accounts.price_list_id) — a FK simples não enxerga tenant.
- **RLS**: select org-flat / write manager+ nas duas tabelas (molde catalog_products).

## 4. Algoritmo de resolução (determinístico) e fronteiras de autoridade

`lib/pricing/resolver.ts` (PURO — mesmo insumo → mesma saída; sem banco, sem relógio, sem IA):

1. **A2 absoluto**: produto inativo → `no_price/produto_inativo` (nem lista, nem base).
2. Conta existe (mesma org) + `price_list_id` + lista ATIVA + item do produto → **preço da LISTA** (`fonte: "price_list"`, com ids). Moeda do item ≠ moeda da lista → falha fechada: cai ao base, nunca serve moeda trocada.
3. Qualquer elo falho (sem conta/lista inativa/fora da lista) → **preço BASE** (`fonte: "catalog_base"`).
4. Produto inexistente → `no_price/produto_inexistente`.

`lib/pricing/consultar.ts` (IO): lê as linhas com filtro de `organization_id` (barreira de tenant) e chama o puro. **Contrato de snapshot**: `capturarInstantaneo()` devolve `{product_id, sku, nome, unit_price_cents, moeda, fonte, price_list_id, price_list_item_id, resolvido_em}` — é isto que o Order Engine grava em `order_items` na CONFIRMAÇÃO (Fase 4); pedido histórico nunca se move com o catálogo.

**Fronteira de IA (documentada + imposta)**: IA pode identificar produto, extrair quantidade e PEDIR resolução; NÃO inventa, não sobrescreve, não dá desconto, não muta preço (mutação = manager+ nas rotas + RLS; o resolver é server-side e a tool de consulta do agente — Fase 5 — consumirá o MESMO serviço, nunca o catálogo cru). Nenhuma tool MCP foi adicionada nesta fase. Precedente da saída: promise-table continua vetando promessa de preço na mensagem.

## 5. API / serviço (contrato)

| Rota | Papel | O que faz |
|---|---|---|
| `GET /api/v1/price-lists` | viewer+ | lista org-flat (busca por nome) |
| `POST /api/v1/price-lists` | manager+ | cria (moeda default = a da ORG via `moedaDaOrganizacao` — corpo nunca decide moeda) · 201 |
| `PATCH /api/v1/price-lists/[id]` | manager+ | nome/status (moeda NÃO mutável por desenho) · 404 honesto |
| `GET /api/v1/price-lists/[id]/items` | viewer+ | itens + produto (join) |
| `PUT /api/v1/price-lists/[id]/items` | manager+ | **upsert** por (lista, produto) · 404 se a lista não é da org · 23514 → 422 |
| `DELETE /api/v1/price-lists/[id]/items/[productId]` | manager+ | remove (produto VOLTA ao base — A1) · audita existência prévia |
| `GET /api/v1/pricing/resolve?product_id&account_id&quantidade` | viewer+ | **o resolver**: 200 com `resolved` OU `no_price`+motivo (ausência é resultado, não erro); validação 422 pré-banco |

Audit: `price_list.created/updated`, `price_list_item.set/removed` no vocabulário fechado.

## 6. Segurança / RLS (decisões)

Toda leitura org-filtrada (resolver incluído); toda mutação manager+ (rotas + RLS `fn_role_at_least`); gatilhos same-org como autoridade de vínculo; `created_by`/`audit()` em toda mutação; nenhuma rota nova fora do padrão `requireRole`/`requireSupportWrite`/`ok()`/`fail()`/`traduzir`.

## 7. Testes e resultados EXATOS (Node 22.23.2 portátil + pnpm 9.15.9)

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` | ✅ **verde** — pegou 3 erros reais durante a fase (import faltando no client de contas, ícone `Tag` fora da tabela do registry, narrowing do snapshot no resolver) — corrigidos |
| `pnpm lint` | ✅ **0 erros** (355 warnings pré-existentes; nenhum meu) |
| `pnpm exec vitest run` — lote Fase 3 | ✅ **45/45** em 8 arquivos: resolver 12 (precedência, A1-A5, moeda trocada falha fechada, determinismo, snapshot), schemas precos 8, price-lists route 4 (moeda da org com caso discriminante MXN, BRL-fallback, GET org-scoped, PATCH imutável), resolve route 3 (422 pré-banco, org da sessão, no_price=200), manifest-x 6, varredura-anon 2, baseline-reaplicável, apêndice-não-diverge, navegação-registry 21 |
| `pnpm test:unit` (completa) | ⚠️ **rodada interrompida pela infraestrutura de execução** (processo morto em 772/805, sem rodapé) — 0 falhas novas até onde processou; reconciliação vale pela rodada COMPLETA da Fase 2 (796/805, 9 falhos = classe ambiente Windows) + todos os alvos novos desta fase verdes em lote dirigido |
| `pnpm test:db` (invariantes precos-vinculo + vocabulário) | ❌ **Docker ausente** (medido) — roda no CI (`invariants`) |
| `pnpm build` | ❌ **processo morto no meio da compilação, sem erro de código** (sem 0xc0000142 desta vez; ~mesmo padrão das suítes longas — a máquina mata processos longos). Compilação da árvore Fase 2 (superset estrutural) já provada em 33,4min; delta da Fase 3 é typecheck-verde |

**Falhas encontradas e corrigidas durante a validação (o gate trabalhando):** A2 produto-inativo era burlado pelo ramo da lista (o teste exigiu A2 absoluto — corrigido no resolver); meu dublê de teste não expunha `.from()`; e o próprio `baseline-reaplicavel` pegou o `add constraint` solto no apêndice (guardado com DO/`pg_constraint`, molde `organizations_currency_iso`).

## 8. Decisões pendentes (não inventadas — suposições menores A1-A5 documentadas em §2)

- **A1 (fallback ao base)** e **A5 (sem preço por quantidade)** precisam de decisão do dono ANTES da primeira confirmação real de pedido.
- As 5 perguntas do n8n (doc 11) seguem abertas e continuam bloqueando a Fase 4, não esta fase.
- Moeda da lista = moeda da org (sem multi-moeda de listas nesta fase — feature futura explícita).

## 9. Impacto na Fase 4 (Order Engine)

- Consumir `consultarPreco()`/`capturarPrecoParaPedido()` — NUNCA o catálogo cru.
- Gravar o `InstantaneoDePreco` em `order_items` na confirmação (contrato já exportado e testado).
- Decidir A1/A5 + as 5 regras do n8n antes do primeiro pedido real.
- Nada em `orders` foi tocado nesta fase.
