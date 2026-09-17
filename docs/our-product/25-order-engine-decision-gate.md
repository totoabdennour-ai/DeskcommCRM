---
type: our-product/phase-3
doc: 25-order-engine-decision-gate
status: final — portão de decisões para a Fase 4
created: 2026-09-17
freezes: Fase 3 (pricing foundation, não commitada na data deste doc)
sources: docs/our-product/24 (implementação), 21 (síntese), 11 (n8n), DECISIONS.md
rule: "Nenhuma política de negócio foi inventada — cada A tem o default MENOR já implementado e as escolhas com impacto."
---

# 25 — Portão de decisões para o Order Engine (Fase 4)

A Fase 3 congelou o **contrato** de preço (resolver determinístico + snapshot), não a
**política** comercial. Este documento lista, para cada decisão pendente: o comportamento
hoje implementado, a pergunta de negócio em aberto, as escolhas concretas com o que cada
uma muda no Order Engine, e o menor impacto de schema/serviço de cada escolha.

**Regra transversal que nenhuma decisão abaixo muda:** preço unitário, subtotal, total,
validade e desconto são SEMPRE calculados pelo resolver/banco (DECISIONS D4); IA propõe;
snapshot congela o histórico (D21); `orders` é reusada com `origin` (D3).

---

## A1 — Fallback da lista da conta para o preço base

- **Hoje (implementado)**: conta com lista ativa que NÃO tem item para o produto →
  resolver devolve o preço **base** do catálogo (`fonte: "catalog_base"`, A1 no resolver).
- **Pergunta de negócio**: quando o produto não está na lista da conta, o cliente paga o
  preço de catálogo — ou NÃO pode comprar (lista é lista fechada/exclusiva)?
- **Escolhas**:
  1. **Herdar o base (atual)** — lista é desconto, não gaiola. Order Engine: pedido
     confirma com preço base; nenhuma checagem extra.
  2. **Recusar** (`no_price` → linha não confirma) — lista é o catálogo exclusivo da
     conta. Order Engine: item sem item-de-lista trava o rascunho e exige ação do
     vendedor (remover linha ou negociar inclusão na lista).
  3. **Por configuração da LISTA** (knob `herda_base` na lista) — resolve os dois mundos
     por lista, custo maior.
- **Impacto no Order Engine**: escolha 1 = zero trabalho extra; 2 = validação de
  confirmação precisa recusar linha `catalog_base` quando a conta tem lista; 3 = knob +
  leitura no resolver (1 coluna na lista, 1 ramo).
- **Menor impacto**: manter 1. Mudar depois = 1 coluna + 1 condição no resolver.
- **RECOMENDAÇÃO**: 1 (atual), revisar com o primeiro cliente real.

## A2 — Produto inativo

- **Hoje**: produto `ativo = false` → `no_price/produto_inativo` **absoluto** — nem a
  lista, nem o base servem preço (teste trava).
- **Pergunta**: produto fora de circulação realmente não pode entrar em pedido? E pedido
  de reposição de item descontinuado?
- **Escolhas**:
  1. **Recusar (atual)** — produto inativo não entra em pedido novo (reposição passa a
     exigir reativar o SKU no catálogo).
  2. **Permitir via lista** — item de lista ativa serve preço mesmo inativo (lista como
     exceção explícita do operador).
  3. **Permitir só em réplica** (cópia de pedido anterior) — modalidade fora do MVP.
- **Impacto**: 1 = zero; 2 = inverter a precedência A2 no resolver (1 condição + 1 teste);
  3 = feature nova de réplica (Fase futura).
- **RECOMENDAÇÃO**: 1 para o piloto (A2 absoluto é o mais previsível).

## A3 — Lista inativa

- **Hoje**: lista `inactive` é **ignorada** na resolução — as contas dela voltam ao base
  (desligar a lista é "voltar ao catálogo", não "bloquear compra").
- **Pergunta**: desativar uma lista significa "todos de volta ao catálogo" (atual) ou
  "as contas desta lista ficam sem preço" (bloqueio em massa)?
- **Escolhas**: 1. Volta ao catálogo (atual) — desativação é operação segura e reversível.
  2. Bloqueio — desativar lista trava pedidos de N contas de uma vez (operador precisa
  saber que é uma arma). Impacto: 1 = zero; 2 = o inverso do A1-escolha-2 (mesma
  validação de confirmação).
- **RECOMENDAÇÃO**: 1 (atual). É o que torna "Desativar" um botão seguro na tela.

## A4 — Moeda divergente (lista × produto × org)

- **Hoje**: a moeda do ITEM é a da LISTA (o item não tem coluna de moeda — divergência é
  impossível no banco); se um dia o insumo divergir, o resolver **falha fechado** (cai ao
  base, nunca serve moeda trocada). Base usa a moeda do produto. Nenhuma conversão.
- **Pergunta**: precisa de listas em moeda diferente da moeda da organização (importação,
  fronteira)? E o PEDIDO inteiro em qual moeda?
- **Escolhas**: 1. **Uma moeda por org (atual)** — listas e produtos herdam a moeda da
  organização; mistura teoricamente impossível; Order Engine valida que toda linha tem a
  moeda da org (fail-closed) e grava `orders.currency` = moeda da org. 2. Lista em moeda
  própria — feature explícita: coluna já existe (`price_lists.moeda`), mas o engine
  precisaria de política de pedido multi-moeda ou conversão (doc 17 Q3 — aberto).
- **Impacto**: 1 = validação de homogeneidade no engine (1 invariante); 2 = decisão de
  conversão + relatório multi-moeda (doc 18 §"nunca duplicado") — grande.
- **RECOMENDAÇÃO**: 1 para o piloto (é o estado implementado de fato: o catálogo e as
  listas nascem na moeda da org).

## A5 — Preço por quantidade

- **Hoje**: o resolver aceita `quantidade` no contrato mas **não muda o unitário** (A5) —
  sem tabela de faixas, sem desconto por volume.
- **Pergunta**: distribuição tem preço por faixa (10+ caixas = X)? Se sim, as faixas são
  por PRODUTO, por LISTA ou por CONTA?
- **Escolhas**:
  1. **Sem faixas (atual)** — quantidade multiplica o unitário no engine; preço por
     faixa vira Fase futura.
  2. **Faixas por item de lista** — nova tabela `price_tiers` (item_id, min_qty,
     preco_cents); resolver ganha um passo determinístico entre item e base; o snapshot
     passa a incluir a faixa aplicada.
  3. **Percentual por volume na conta** — `accounts.settings.b2b.volume_discount_pct`;
     desconto passa a existir como cálculo (hoje desconto é só teto da promise-table).
- **Impacto**: 1 = zero; 2 = 1 tabela + 1 ramo no resolver + snapshot com faixa; 3 = 1
  campo + cálculo no engine + risco de conflito com `maxDiscountPercent` da promise-table.
- **RECOMENDAÇÃO**: 1 no piloto; 2 é o caminho natural se o cliente pedir (o contrato do
  snapshot já comporta `price_list_item_id` como chave da faixa).

## A6 — Snapshot: quando e o que exatamente (fechando a pergunta 5)

- **Hoje (contrato implementado e testado)**: o snapshot congela na **CONFIRMAÇÃO** do
  pedido (`capturarInstantaneo()` → `{product_id, sku, nome, unit_price_cents, moeda,
  fonte, price_list_id, price_list_item_id, resolvido_em}`). RASCUNHO mostra preço VIVO
  (re-resolvido a cada consulta — nunca armazenado como verdade); CONFIRMADO é imutável:
  mudança de catálogo/lista não afeta pedido histórico; emenda cria evento novo com
  snapshot novo por linha alterada (doc 14, invariante 3).
- **Pergunta de negócio**: há modalidade em que o cliente exige preço CONGELADO por prazo
  (cotação com validade de 7 dias)? Se sim, a validade é atributo do snapshot (hoje:
  `resolvido_em` apenas registra o instante; NÃO expira nada).
- **Escolhas**: 1. Congela na confirmação, sem validade (atual) — cotação é a mensagem
  da conversa, o pedido confirma na hora. 2. Cotação com validade — nasce um estado
  `quoted` com `preco_valido_ate` na oportunidade/rascunho e o engine re-resolve se
  expirar (2 colunas + 1 regra no engine; toca a decisão "cotação não é entidade" — D18).
- **RECOMENDAÇÃO**: 1 (atual, alinhado a D18). Reabrir D18 só com cliente real pedindo.

---

## Outras decisões tecnicamente exigidas antes do Order Engine (além de A1–A5)

**B1 — Contrato de confirmação** (quem/what valida o "sim" do cliente): o pedido só
avança `draft → confirmed` com confirmação EXPLÍCITA do cliente (D5, doc 14 invariante).
A pergunta: o "sim" pode ser interpretado pela IA (declaracao do turno) ou exige
palavra-chave determinística/ação do operador? Escolhas: (a) IA interpreta + guarda
humano configurável por org; (b) só operador confirma pela tela. Impacto: (a) reusa a
declaração do turno (Zod strict) + 1 gate no engine; (b) só UI. **Recomendação**: (a) com
gate humano ligado por default (o mesmo padrão MFA: fácil de desligar, seguro de nascer).

**B2 — Numeração/external_id de pedidos nativos**: `orders.external_id` é NOT NULL e
único por (org, provider). Pedidos nativos precisam de um esquema (uuid? sequência
legível `PED-2026-0001`?). Impacto: nenhuma tabela nova; é política de geração na rota.
**Recomendação**: sequência legível por org (o operador e o ERP citam o número).

**B3 — Vocabulário de `orders.origin`**: D3 aprovou reusar `orders` com origem; o CHECK
novo precisa dos valores: proposta = `('manual','erp','nuvemshop')`. Impacto: a própria
migration da Fase 4. Sem decisão de negócio real além de ratificar.

**B4 — MOQ e valor mínimo: ONDE é imposto** (n8n Q1): o MOQ é por LINHA (produto×qtd) ou
por PEDIDO (valor total)? E a falha (doc 11): recusa o rascunho, confirma parcial, ou
escala humano? Impacto: validação no engine pré-confirmação + campo de dados
(`accounts.settings.b2b` ou por produto). **Recomendação**: por linha e por pedido como
dois knobs separados; falha = recusa com motivo legível + escala humano configurável.

**B5 — Limite de crédito: bloqueio ou alerta** (doc 17 Q4): sem financeiro no RevenueOS
(D8), o "limite" é um campo da conta comparado ao total de pedidos abertos. Impacto: 1
campo + 1 consulta no engine. **Recomendação**: alerta na Central + confirmação exigindo
aprovação humana quando estourar (nunca bloqueio silencioso).

**B6 — Substituição de SKU** (n8n Q2): se o item não tem preço/estoque, o agente oferece
alternativa conversacional (já faz com empate/ambiguidade na busca) — mas SUBSTITUIR linha
de pedido precisa de regra (automática com confirmação do cliente? só sugerir?).
**Recomendação**: só sugerir na conversa; a linha do pedido muda apenas com o "sim" do
cliente (B1). Sem tabela de substitutos no MVP (o vínculo de alternativa é fase posterior).

**B7 — Identidade: chave da conta na hora do pedido** (n8n Q3): o pedido é da CONTA; a
conversa é do CONTATO. Contato sem conta informada → pedido sem conta? Recusa? Pergunta
na conversa? **Recomendação**: exigir conta no rascunho (o agente pergunta) — o vínculo
contato→conta já existe (0239).

---

## REQUIRED DECISIONS BEFORE PHASE 4

| # | Decisão | Default implementado/proposto | Bloqueia |
|---|---|---|---|
| A1 | Fallback ao base | Herdar o base | Confirmação de linha sem item de lista |
| A2 | Produto inativo | `no_price` absoluto | Confirmação |
| A3 | Lista inativa | Volta ao catálogo | Confirmação |
| A4 | Moeda única da org + fail-closed | Sim | Gravação de `orders.currency` |
| A5 | Sem faixa de quantidade | Sim | Cálculo de linha |
| A6 | Snapshot na confirmação, sem validade | Sim | Estrutura de `order_items` |
| B1 | Contrato de confirmação | IA interpreta + gate humano default | Transição draft→confirmed |
| B2 | Numeração nativa | Sequência legível por org | INSERT em `orders` |
| B3 | `origin` = manual/erp/nuvemshop | Proposto | Migration do CHECK |
| B4 | MOQ por linha/pedido + falha | Recusa legível + escala | Validação pré-confirmação |
| B5 | Crédito | Alerta + aprovação humana | Validação pré-confirmação |
| B6 | Substituição | Só sugerir na conversa | Emenda de linha |
| B7 | Pedido exige conta | Agente pergunta | Criação do rascunho |

## CURRENT DEFAULTS IMPLEMENTED (o que já está em código hoje)

- A1 herdar o base · A2 no_price absoluto · A3 lista inativa ignorada · A4 moeda da
  lista governa o item + fail-closed · A5 quantidade não muda unitário · A6 snapshot na
  confirmação com o contrato `InstantaneoDePreco` · mutação de preço manager+ ·
  resolução server-side única (`consultarPreco`) · nenhuma tool de IA de preço.

## OPEN QUESTIONS (não-bloqueantes, mas que a Fase 4 pode reabrir)

- D18 (cotação não é entidade) — reabrir apenas com exigência real de validade de preço.
- Multi-moeda de listas / relatório consolidado (doc 17 Q3) — Fase 10.
- `account_prices` (override pontual fora de lista) — só com demanda real; a lista já cobre.
- Painel 360 da conta com contatos e pedidos (doc 23 §7) — tela da Fase 7.

## PHASE 4 BLOCKERS (o que EFETIVAMENTE impede começar a Fase 4)

1. **A1–A6 ratificados ou alterados pelo dono** (10 min de decisão; os defaults são
   implementados e podem ser mantidos com um "aprovado como está").
2. **B1–B3 decididos** (confirmação, numeração, origin) — sem eles a migration de
   `orders` e a transição de confirmação não têm contrato.
3. **B4–B7**: podem entrar como defaults recomendados com a mesma cláusula do A1
   ("aprovado como está"), mas precisam de aceite explícito no doc.
4. As 5 respostas do n8n (doc 11) continuam bloqueando a LÓGICA de falha de
   confirmação/sincronização — mas NÃO o início da Fase 4 (migration + engine esqueleto
   + UI podem começar com os defaults B4–B7 marcados como reversíveis).
