---
type: our-product/phase-4
doc: 26-phase-4-order-engine-completion-report
status: final
created: 2026-09-17
baseline: Fase 3 commitada (aaa2c07d)
decisions_source: docs/our-product/25 (A1–A6 implementados como defaults; B1–B7 nos valores propostos)
---

# 26 — Relatório de conclusão da Fase 4 (Order Engine)

## 1. Auditoria inicial (reuso antes de rebuild)

- **`orders`**: espelho header-only com RLS org-flat (`orders_tenant_select/write`), CHECKs de espelho (status/provider), `total_cents CHECK >= 0`, `idempotency_keys` (TTL 24h) já existentes — TUDO reusado; a tabela foi **ampliada**, não substituída (D3).
- **4 leitores vivos** de `orders` preservados e intocados: `crm_list_contact_orders` (MCP), painel do inbox (`crm-summary`), export LGPD (preserva totais), stats admin.
- **Preço**: o resolver da Fase 3 é a ÚNICA fonte de preço — o engine nunca lê o catálogo cru nem aceita preço do corpo (D4/D20).
- **Outbox**: precedente `fn_create_tenant_with_owner` (RPC SECURITY DEFINER transacional) + `emit_event()`; `emitirEventoAguardado` (F1) para o barramento onde não há trigger.
- **Zero order_items/order_events** — confirmado por varredura antes de criar.

## 2. Modelo final (migration 0241 — tripla: migration + baseline ANTES da varredura + MANIFEST)

- **`orders`**: + `origin` (NOT NULL default 'manual', backfill = external_provider para espelhos) + `account_id` (FK SET NULL + gatilho same-org) + CHECKs ampliados com guardas DO/`pg_constraint` (external_provider ganha 'manual'; status ganha draft/confirmed/closed) + `orders_native_tem_conta` (**B7 no banco**: origin='manual' ⇒ account_id NOT NULL) + índices (org+origin, org+account parcial).
- **`order_items`**: linhas com o **snapshot congelado** (A6): product_id (SET NULL — produto removido, snapshot fica), sku/nome NOT NULL (fato histórico), quantity > 0, unit_price_cents ≥ 0, moeda, fonte CHECK (price_list|catalog_base), price_list_id/item_id, resolvido_em. RLS: **select org-flat, SEM policy de escrita** — linhas nascem só dentro das RPCs (security definer) ou service_role. Gatilho same-org para o produto da linha.
- **`order_events`**: log de domínio append-only (seq identity, kind CHECK created/edited/confirmed/cancelled, actor_kind user/ai/system, actor_user_id). RLS: select-only idem.
- **RPCs do engine** (SECURITY DEFINER, org-validada, granted authenticated+service_role, revogadas de public/anon): `fn_criar_pedido`, `fn_confirmar_pedido` (substitui linhas pela resolução FRESCA + recalcula total), `fn_editar_rascunho` (só draft), `fn_cancelar_pedido` (draft|confirmed, motivo obrigatório no payload), `fn_registra_evento_do_pedido` (grava order_events **e** event_log `order.*` NO MESMO COMMIT — outbox real; consumidor assíncrono é opt-in).

## 3. Engine TS (`lib/orders/`)

- `tipos.ts`: máquina de estados pura (`transicaoValida`), total calculado (DIRC), numeração nativa B2 (`PED-<ano>-<12hex>` — legível, sem corrida; sequência por org é upgrade), schemas Zod (corpo carrega **só** account + produto + quantidade — preço nunca entra).
- `engine.ts` (IO): `criarRascunho` (resolve cada linha → 1 linha sem preço recusa o PEDIDO inteiro com motivo; moeda mista recusa — A4), `confirmar` (**re-resolve tudo no instante da confirmação** — A6), `editarRascunho` (só draft, preço vivo), `cancelar`. Chamado pelas rotas e pelas tools.

## 4. API / tools (contrato)

| Superfície | Papel | Comportamento |
|---|---|---|
| `POST /api/v1/orders` | agent+ | rascunho idempotente (**Idempotency-Key honrada server-side**: mesma chave+corpo → resposta gravada; corpo diferente → 409; recusa de domínio 422 também é gravada) |
| `GET /api/v1/orders` · `GET /[id]` | viewer+ | lista org-flat (filtro status) · pedido completo (cabeçalho+linhas+eventos) |
| `PATCH /api/v1/orders/[id]` | manager+ | só draft; re-resolve linhas; recusa 409 em confirmado |
| `POST /api/v1/orders/[id]/confirm` | manager+ | **A6**: re-resolve → congela → confirmed; nenhuma tool de IA confirma (B1) |
| `POST /api/v1/orders/[id]/cancel` | manager+ | motivo obrigatório (chega ao evento) |
| Tools MCP `crm_create_order` (write, **ai_operator**)/`crm_get_order` (read, agent) | pacote novo **"pedidos"** | o agente monta RASCUNHO (produto+quantidade apenas; recusa modelada com motivo e instrução anti-invenção) e consulta estado; confirmação é humana |

Audit: `order.created/updated/confirmed/cancelled` no vocabulário fechado; recusa 422 NÃO audita (doutrina "audita quando há efeito").

## 5. Fronteira de IA (enforcada em 3 camadas)

1. A tool manda só produto/quantidade — o Zod descarta preço; o resolver decide.
2. `crm_create_order` exige **ai_operator** (gate `capacidade-alcancavel` reprovou `agent` — corrigido) e devolve recusa **modelada** com instrução anti-invenção.
3. NÃO existe tool de confirmação; a rota de confirmar exige manager+; o pacote `pedidos` é opt-in do operador (não entra em agente novo por default).

## 6. Testes e resultados EXATOS (Node 22.23.2 portátil + pnpm 9.15.9)

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` | ✅ **verde** — pegou 8 erros reais durante a fase (imports faltando, ícone, narrowing de snapshot, tipo `LinhaResolvida`, moeda no schema), todos corrigidos |
| `pnpm lint` | ✅ **0 erros** (355 warnings pré-existentes) |
| Lote dirigido Fase 3+4 | ✅ **283/283** (13 arquivos) e após os gates de tools ✅ **241/241** + **45/45** (F3) — inclui: tipos do engine (transições, total, numeração), rota de pedidos (idempotência nos 3 cenários, preço nunca do corpo, org da sessão, no_price=422), tools (leigo-friendly, capacidade-alcancável, escopo-de-funil, pacote-reserva), gates de baseline (reaplicável/apêndice/anon/manifest) |
| `pnpm test:unit` (COMPLETA) | ✅ **rodou até o fim: 811 arquivos — 804 passaram; 8.538 casos — 8.528 passaram, 1 expected-fail.** Os 7 arquivos falhos: 4 da classe ambiente Windows (lgpd-pdf ×4 casos, rascunho-superado — separador de caminho; sem-marcador — timeout de varredura) + 3 gates de tools que **reprovaram a 1ª versão das tools e foram consertados** (capacidade: role `agent`→`ai_operator`; escopo-de-funil: classificar `crm_create_order: "sem_funil"`; pacote-reserva: pacote novo `pedidos` em vez de inflar `vender`) — todos re-verificados verde (241/241) |
| `pnpm test:db` (invariantes orders-vinculo + orders nos 3 TABLES do rls-isolation) | ❌ **Docker ausente** (medido) — roda no CI; os invariantes cobrem: B7 no CHECK, outbox no mesmo commit (order_events + event_log juntos), total=Σ, transição dupla recusada, same-org (conta/produto/cancel), SET NULL de conta |
| `pnpm build` | não re-tentado nesta fase: a instabilidade de spawn/long-run do Windows está documentada na Fase 3 (0xc0000142 ×2 e morte silenciosa); a compilação da Fase 2 (superset estrutural) foi provada e o delta é typecheck-verde — prova final cabe ao CI |

## 7. Decisões aplicadas (doc 25) e o que ficou para depois

**Aplicadas como default**: A1–A6 (herdar base, no_price absoluto, lista inativa ignorada, moeda única fail-closed, sem faixa, snapshot na confirmação), B2 (numeração hex legível), B3 (origin CHECK manual/nuvemshop/vtex/shopify/erp), B7 (conta obrigatória NO BANCO). **Não implementadas de propósito (sem política inventada)**: B4 MOQ, B5 crédito — entram quando o piloto definir valores; o ponto de encaixe é a validação pré-confirmação da rota confirm. **B1** segue com gate humano por default (a rota confirm é manager+; tool de IA de confirmação não existe).

**Fora do escopo respeitado**: emenda de pedido CONFIRMADO (cancela-e-refaz por ora; emenda como evento é F7), fulfillment/delivery (espelho ERP, F9), sync_ledger (F9), UI de operação (F7), drainer dedicado (as transições emitem event_log no commit; nenhum consumidor assíncrono novo nesta fase).

## 8. Riscos conhecidos

- `test:db` não executou localmente (Docker) — os RPCs e os 3 TABLES novos do rls-isolation estreiam no CI. O SQL segue os padrões provados (0239/0240), mas não houve execução real de banco nesta fase.
- Emenda de pedido confirmado exige cancelar-e-refaz até a F7 — trade-off documentado, não silencioso.
- O `Idempotency-Key` é honrado em 1 rota nova (orders) — o total de rotas com idempotência server-side subiu para 5; o contrato promete "POSTs de criação" e a migração do resto segue dívida antiga (doc 03).

## 9. Impacto nas próximas fases

- **F5 (agentes)**: ligar o pacote `pedidos` no agente B2B; extração de rascunho pela conversa (generateObject) consome `criarRascunho`; confirmation-gate B1 vira guardrail antes-send se a IA passar a falar "confirmado".
- **F7 (operação humana)**: fila de rascunhos→confirmar usa as rotas prontas; emenda de confirmado (order_events kind=amended).
- **F9 (ERP)**: `orders_external_id` nativo é a chave; sync_ledger ancora em `order_events`.

---

# F4.1 — Correção dos dois bloqueadores do freeze review

O freeze review (STATUS: BLOCKED) encontrou dois defeitos concretos de dinheiro/estado.
Ambos corrigidos nesta rodada, com regressão travada. Nada além dos dois foi alterado.

## F4.1-1 — `orders` volta a ser SELECT-ONLY para authenticated

- **Defeito original**: a policy `orders_tenant_write` (herdada da era-espelho, quando
  ninguém escrevia na tabela) dava **write org-flat a qualquer papel**. Com o engine
  ativo, qualquer membro autenticado — inclusive `viewer` — podia mutar `status`/`total_cents`
  direto pelo PostgREST, **por fora da máquina de estados, sem order_events e sem event_log**
  (pedido "confirmado" fantasma, sem trilha).
- **Causa raiz**: `orders` herdou a policy do espelho; quando a tabela virou dinheiro,
  a policy ficou para trás enquanto as tabelas novas (order_items/order_events) nasceram
  select-only.
- **Correção**: `drop policy if exists orders_tenant_write` na migration 0241 + apêndice
  do baseline (o guard do dump recria e o apêndice derruba — estado final sempre correto
  em install e update). Escrita legítima: RPCs security definer + service_role (o futuro
  escritor de espelho da F9 passa direto). SELECT org-flat intacto para a leitura de operação.
- **Regressão** (`tests/invariants/orders-vinculo.test.ts`, bloco F4.1-1, com JWT simulado
  pelo caminho de produção): UPDATE de membro afeta **0 linhas** e não muda total/status;
  INSERT direto → **42501** (violacao de RLS sem policy de escrita); DELETE não apaga;
  CONTROLE: a RPC do engine continua criando (escrita via definer funciona).

## F4.1-2 — Idempotência TRANSACIONAL (mesma transação do pedido)

- **Defeito original**: a rota gravava a Idempotency-Key **depois** do commit de
  `fn_criar_pedido`. Duas janelas de duplicação: (a) crash/deploy entre pedido e chave —
  re-entrega criava segundo pedido; (b) duas requisições concorrentes com a mesma chave
  liam "sem chave" antes de qualquer gravação — duas corridas.
- **Causa raiz**: a chave morava fora da transação do dinheiro; o padrão correto do repo
  (`fn_create_tenant_with_owner(p_key, ...)`) consome a chave DENTRO do commit.
- **Correção**: `fn_criar_pedido` ganhou `p_key`/`p_request_hash` e retorna `jsonb`:
  insere a chave na `idempotency_keys` PRIMEIRO (mesma transação), grava o pedido/linhas/
  eventos, atualiza o `response_body` com o resultado final e devolve
  `{replay, order_id, external_id, status, total_cents}`. Mesmo hash → **replay do
  resultado gravado** (`replay: true`, sem segundo pedido, sem audit de efeito novo);
  hash diferente → raise `idempotency_conflicting_body` → a rota mapeia **409**; qualquer
  falha depois (gatilho/constraint) **rollbacka chave e pedido juntos**. `p_key` vazio
  (chamadas internas/seed) não cria linha de idempotência. A rota não faz mais upsert
  pós-commit — o bloco foi removido.
- **Regressão**: rota (`route.test.ts`): chave+hash viajam ao engine; replay → 201 com
  `replay: true` e **sem audit**; conflito → 409 determinístico; replay não apresenta
  linhas frescas. Invariante (bloco F4.1-2, Postgres real no CI): 1ª chamada cria pedido
  + chave; 2ª com mesmo hash → `replay: true` e **zero pedido duplicado**; hash diferente
  → `P0001`; **rollback não consome a chave** (produto invasor derruba transação inteira:
  nem pedido, nem chave); chave vazia não cria linha.

## Validação F4.1 (exata)

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` | ✅ **verde** (pegou 3 erros reais no caminho: contrato `PedidoCriado` no mock/handler da tool — corrigidos; + 1 erro de PARSE nos literais bytea do invariante, corrigido) |
| `pnpm lint` | ✅ **0 erros** (355 warnings pré-existentes) |
| `app/api/v1/orders/route.test.ts` + `lib/orders/tipos.test.ts` + i18n sweep | ✅ **20/20** |
| `pnpm test:unit` (completa, pós-F4.1) | ✅ **811 arquivos — 807 passaram; 4 falhos = classe ambiente Windows documentada** (lgpd-pdf ×4, rascunho ×1, sem-marcador ×1) — idêntico ao pós-F4; os 3 gates de tools passaram na suíte completa |
| `pnpm test:db` (invariantes F4.1 + orders-vinculo inteiro) | ❌ Docker ausente — CI (`invariants`) |
| `pnpm build` | não re-tentado (instabilidade documentada; compilação F2 provada, delta typecheck-verde) |

**Correções no caminho**: a mudança de contrato do engine (`pedido: PedidoCriado` com
flag `replay`) exigiu atualizar o handler da tool `crm_create_order` e o mock do teste
de rota; o heredoc de escrita do invariante comeu o escape duplo de 3 literais bytea
(TS1125 + lint parse error — o gate de lint pegou).

