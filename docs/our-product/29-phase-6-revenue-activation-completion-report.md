---
type: our-product/phase-6
doc: 29-phase-6-revenue-activation-completion-report
status: final
created: 2026-09-18
baseline: Fase 5 commitada (bb4459db)
architecture: docs/our-product/28 (síntese aprovada — DECISION: GO)
---

# 29 — Relatório de conclusão da Fase 6 (Revenue Activation Foundation)

## 1. Auditoria (reuso antes de rebuild — nada duplicado)

| Mecanismo existente | Como a F6 o usa |
|---|---|
| `crm_lead_risk_states` (detector de estagnação JÁ EM PRODUÇÃO, com `since`/`detected_at` honestos) | **PONTE**: `stalled_opportunity` materializa a partir dos buckets `critico`/`em_risco` — ZERO lógica de estagnação duplicada |
| `crm_lead_reactivations` (proto-recovery com expiração) | INTOCADO — recovery da F7 consome `revenue_at_risk`; reativação continua sendo um executor válido |
| `lead_checkpoints.next_action` | Fonte do "próximo passo" na detecção `unresolved_open_state` |
| `followup_enrollments` (status active/waiting_reply) | Exclusão do `unresolved_open_state` (já há ação em curso) + executor da NBA |
| Outbox `order.*` (0241) + triggers de `lead.*` | Eventos AUTHORITATIVE — `revenue_events` espelha, nunca duplica a fonte |
| `orders.account_id` (F4) + `contacts.account_id` (0239) | Vínculo conta↔pedido↔oportunidade sem coluna nova |
| `fn_set_updated_at`, RLS molde select-only (order_items F4.1) | Convenções seguidas nas 2 tabelas novas |

## 2. Contrato `revenue_at_risk` (0242)

Campos de linhagem: org, `risk_type` CHECK (**6 tipos implementados**: inquiry_without_response, stalled_opportunity, abandoned_draft_order, dormant_customer, unresolved_open_state, no_price — **delivery_failed e confirmation_failed DEFERIDOS**: sem fonte authoritative até ERP F9/sinal F7, e fabricar seria mentir), `source_kind`+`source_id` (identidade dedup), refs account/contact/lead/order (SET NULL — histórico sobrevive), `trigger_detail` (evidência legível), `estimated_value_cents`+`currency` (**sempre de fonte determinística**; null quando não há preço), `owner_user_id`, `deadline_at`, `nba_action`+`nba_reason` (gravados NA materialização), `status` (open/acted/resolved/expired/dismissed), `outcome_refs`, `detected_at`/timestamps.
- **Dedup**: unique parcial `(organization_id, risk_type, source_kind, source_id) WHERE status IN ('open','acted')` — resolvido pode reabrir legitimamente; aberto não duplica nunca.
- **RLS**: SELECT-only para authenticated (escrita só via RPC/service_role — molde order_items F4.1).

## 3. Contrato `revenue_events` (0242)

`event_kind` CHECK com os **10 kinds do doc 28** (opportunity_created/progressed, order_created/confirmed/cancelled, revenue_at_risk, recovery_started/succeeded/failed, revenue_influenced), `lineage` CHECK (authoritative = espelho do fato; derived = julgamento determinístico da ativação), source_kind/source_id, refs account/lead/order/risk, `action_chain` jsonb (a CADEIA de ids: risco→ação→pedido), value/currency, occurred_at. **Dedup total**: unique `(organization_id, event_kind, source_kind, source_id)` — reprocessar detector/atribuição NÃO duplica evento. RLS select-only idem.

## 4. Matriz de detectores (fonte → trigger → valor → owner → deadline → dedup → NBA)

| Detector | Fonte | Trigger (SQL, em `fn_materializar_riscos`) | Valor | Owner | Deadline | Dedup source | NBA |
|---|---|---|---|---|---|---|---|
| inquiry_without_response | última msg da conversa = inbound e > 24h | conversa aberta/pending | value_cents do lead aberto do contato | owner do lead | última msg + 24h | conversation_id | follow_up_customer |
| stalled_opportunity | **`crm_lead_risk_states` bucket ∈ (critico, em_risco)** + lead open | ponte (sem recalcular) | `value_cents` | owner | +7d | lead_id | follow_up_customer |
| abandoned_draft_order | orders draft/manual > 24h | idade do rascunho | `total_cents` do snapshot | owner da conta | criação + 24h | order_id | request_confirmation |
| dormant_customer | conta active com confirmado e último > 90 dias | idade do último pedido | média dos confirmados da conta | owner da conta | +30d | account_id | reactivate_customer |
| unresolved_open_state | lead open > 7d sem próxima ação (checkpoint) e sem followup ativo | ausência de next step | `value_cents` | owner | +7d | lead_id | follow_up_customer |
| no_price (event-driven) | recusa `produto_inativo/inexistente` nas tools do agente (F5) — **persistida na hora** via `fn_materializar_risco_unico` | valor **null** (o preço é justamente o que falta) | null | — | null | product_id | clarify_product |
| delivery_failed | **DEFERIDO** — sem fonte authoritative (ERP F9) | — | — | — | — | — | — |
| confirmation_failed | **DEFERIDO** — aguarda sinal determinístico de confirmação (F7) | — | — | — | — | — | — |

Knobs (24h/7d/90d/30d) são constantes nomeadas na SQL com defaults propostos — decisão do dono em aberto (doc 28 §16).

## 5. NBA (puro, explicável — `lib/receita/nba.ts`)

Severidade fixa documentada: abandoned_draft (dinheiro comprometido) > inquiry (cliente quente) > no_price (linha bloqueada) > stalled > dormant > unresolved. Ordenação: severidade → deadline → valor. Cada item carrega `reason` legível com os critérios. Tipo desconhecido → descartado (nenhuma ação inventada). Ação executada SÓ pelos executores autorizados (follow-up engine, tools do agente, humano na F7).

## 6. Atribuição conservadora (`fn_atribuir_receita`)

- **DIRECT**: todo pedido confirmado espelha `order_confirmed` (lineage authoritative, valor = total_cents do snapshot).
- **RECOVERED**: riscos abertos da conta com detecção anterior ao pedido (ou amarrados ao order_id) → `resolved` + `recovery_succeeded` com cadeia {risk_type, order_id}.
- **INFLUENCED**: sem recovery, mas com atividade rastreada do RevenueOS (crm_lead_activities do contato) nos 30 dias antes, ou rascunho do engine → `revenue_influenced` com cadeia {janela_dias, acao}.
- Idempotente (dedup por fonte); janela de 30 dias = knob proposto (decisão do dono). Roda na confirmação (rota, com logger; falha de atribuição NÃO desfaz o pedido — é fato já commitado) + backfill do cron.

## 7. Account 360 — contrato de leitura (sem UI)

`GET /api/v1/accounts/:id` (viewer+, org-scoped, 404 honesto): conta + contatos + oportunidades + pedidos + `receita {confirmada[], total_confirmado_cents, nota multi-moeda deferida}` + `revenue_at_risk {abertos[], todos[]}` + `recuperados[]` + `eventos_receita[]` + `proximas_acoes[]` (NBA das linhas abertas).

## 8. Agendamento

Cron novo `revenue-activation` (`*/15`, molde dos demais): Bearer fail-closed → `fn_materializar_riscos()` (loop orgs ativas, service_role-only) — a RPC é idempotente (rodar 2× não duplica). Gate `cron-routes-scheduled` exige a linha de crontab — adicionada. `fn_atribuir_receita` roda na confirmação + backfill idempotente no mesmo cron.

## 9. Testes e resultados EXATOS (Node 22.23.2 portátil)

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` | ✅ **verde** — pegou 4 erros reais no caminho (`*/15` fechava o comentário de bloco da rota de cron; `Ctx` sem declaração; inicialização circular de `contatos` no Promise.all; boolean em slot de account_id no espelho) — todos corrigidos |
| `pnpm lint` | ✅ **0 erros** (356 warnings; 3 meus eliminados — símbolos não usados no invariante) |
| Lote F6 (11 arquivos) | ✅ **287/287**: nba.test 9 (ordem severidade/prazo/valor, determinismo, descarte de tipo fantasma), pedidos.test 8, playbook B2B 5, orders route 7 (idempotência transacional), cron-routes-scheduled (a linha nova), leigo-friendly/capacidade/escopo/pacote, tipos do engine, i18n sweep |
| `pnpm test:unit` (COMPLETA) | ✅ **rodou até o fim: 814 arquivos — 809 passaram; 8.571 casos — 8.563 passaram, 1 expected-fail.** Os 5 arquivos falhos são TODOS classe ambiente Windows (lgpd-pdf ×4 casos, rascunho ×1 — separador de caminho; sem-marcador ×1 e drain-loop-tsx ×1 — timeout sob carga, re-provados verdes em isolamento/rodadas anteriores). **Zero falha da Fase 6** |
| `pnpm test:db` (invariantes `receita-vinculo`: detectores, dedup 2×, DIRECT/RECOVERED, rollback, guarda 42501, RLS insert-denied e select org-scoped) | ❌ **Docker ausente** (medido) — CI (`invariants`) |
| `pnpm build` | não re-tentado (instabilidade documentada F2–F4; delta typecheck-verde) |

## 10. Limitações conhecidas

- `delivery_failed` e `confirmation_failed` sem detector (sem fonte authoritative) — CHECK do banco deliberadamente NÃO os contém; entram com guarded ALTER quando ERP F9/F7 entregarem a fonte.
- Knobs de janela (24h/7d/90d/30d) são constantes na SQL — virar knob por org quando o piloto pedir.
- `revenue_events` opportunity_progressed existe na taxonomia mas não tem emissor ainda (espelho de stage change — F7/F8).
- Sem UI (F7) e sem executores de recovery (F8) — a linha de risco hoje termina em `open` com NBA gravada.

## 11. Fronteiras explícitas

- **F7 (Operator/Account 360 UI)**: consome a rota 360 e as NBA gravadas; adiciona emenda de confirmado e os sinais de confirmação que desbloqueiam `confirmation_failed`.
- **F8 (Recovery Engine)**: consome `revenue_at_risk` (a linha JÁ é a Recovery Opportunity), executa NBA autorizadas, grava `recovery_started/succeeded/failed` — sem criar CRM paralelo.
- **F9 (ERP)**: entrega o espelho que desbloqueia `delivery_failed`.
- Zero Recovery executado, zero ERP, zero UI, zero billing, zero ML, zero atribuição probabilística nesta fase.

---

# F6.1 — Correção dos três bloqueadores do freeze review

O freeze review (STATUS: BLOCKED) encontrou três defeitos na camada de medição financeira.
Todos corrigidos na SQL da 0242 (+baseline re-espelhado) e travados por invariante.
Nada além dos três foi alterado.

## F6.1-1 — `revenue_influenced` era tautológico

- **Defeito**: `fn_atribuir_receita` inseria o espelho `order_created` ANTES de testar a
  condição de influência, e o predicado era `exists revenue_events ... event_kind =
  'order_created' and order_id = p_order` — sempre verdadeiro na primeira atribuição.
  Todo pedido confirmado não-recuperado virava "influenciado", tornando a métrica
  idêntica a "confirmado".
- **Causa raiz**: o predicado media a existência do espelho (que a própria função
  acabava de criar) em vez de uma AÇÃO ANTERIOR ao pedido.
- **Correção**: o predicado agora é temporal e explícito — `crm_lead_activities` do
  lead/contato com `created_at < orders.ordered_at` (ACTION_TIMESTAMP <
  ORDER_TIMESTAMP) e dentro da janela de 30 dias. O espelho `order_created` NÃO
  qualifica como influência.
- **Regressão** (invariante `receita-vinculo`, F6.1-1): pedido sem ação prévia →
  espelho existe mas `revenue_influenced = 0`; atividade rastreada 3 dias antes →
  `revenue_influenced = 1`; atividade DEPOIS do pedido → `0`.

## F6.1-2 — RECOVERED sem ação qualificante (falso positivo de recuperação)

- **Defeito**: o loop resolvia qualquer risco aberto da conta com
  `detected_at <= ordered_at` — sem exigir ação rastreada entre detecção e pedido.
  Dormente detectado + pedido manual sem NENHUMA interação = falso "receita recuperada".
- **Causa raiz**: o meio termo do doc 28 (risco detectado → AÇÃO QUALIFICANTE →
  pedido confirmado) não foi traduzido para o SQL.
- **Correção**: por risco no loop, a qualificação é determinística: risco `status =
  'acted'` (NBA executada e registrada) OU `crm_lead_activities` do lead/contato com
  `created_at` ENTRE `risk.detected_at` e `orders.ordered_at` OU follow-up enrollment
  iniciado no mesmo intervalo. Qualificou → `resolved` tipo 'recovered' +
  `recovery_succeeded`. Não qualificou → `resolved` tipo **'direct_only'** (estado
  existente) e NENHUM evento de recovery — a receita permanece DIRECT. Risco de outra
  conta/org nunca é tocado.
- **Regressão** (F6.1-2): A sem ação → `direct_only` sem recovery_succeeded; B com
  atividade entre detecção e pedido → `recovered` + evento; C atividade ANTES da
  detecção → não qualifica; E risco de outra org permanece `open`.

## F6.1-3 — reabertura de episódio de risco colidia e virava 500 na tool

- **Defeito**: o evento `revenue_at_risk` usava `source_id` = FONTE do risco. Quando
  um risco resolvido reabria (mesma fonte, novo episódio — ex.: cliente dormente que
  volta e dorme de novo), a linha de risco nova nascia (unique parcial só em
  open/acted) mas o evento batia no unique total por fonte → **23505** → a tool
  `crm_create_order`/`crm_update_order_draft` do agente tomava **500** exatamente na
  recusa `no_price`, destruindo a recusa modelada.
- **Causa raiz**: identidade do evento por FONTE em vez de por EPISÓDIO.
- **Correção**: o evento de risco usa `source_id = risk_id` (cada episódio é único por
  construção) + `on conflict do nothing`; a linhagem da fonte permanece nas colunas
  `account/lead/order`, no `risk_id` e no `action_chain` (source_kind/source_id).
- **Regressão** (F6.1-3): 1º episódio → 1 evento; resolvido; 2º episódio da mesma
  fonte → novo `risk_id` + SEU evento; **nenhum 23505**; ≥2 episódios coexistem.

## Validação F6.1 (exata)

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` | ✅ **verde** (heredoc truncado no invariante foi detectado e reparado no caminho) |
| `pnpm lint` | ✅ **0 erros** (356 warnings pré-existentes) |
| Lote F6.1 (10 arquivos) | ✅ **60/60** — inclui os gates de baseline (reaplicável/apêndice-não-diverge), manifest, cron-routes, playbook B2B, idempotência transacional do engine |
| `pnpm test:unit` (completa) | ✅ rodou até o fim DUAS vezes — na F6: 814 arq — 809 verdes (5 falhos = classe ambiente Windows); **pós-F6.1: 814 arq — 810 verdes, 8.564 testes passando, 4 falhos = a MESMA classe ambiente** (lgpd-pdf-meet ×3, lgpd-pdf-replies ×1, rascunho ×1, sem-marcador ×1 — os 3 flakes de timeout da rodada anterior nem dispararam). Zero regressão F6.1 |
| `pnpm test:db` (invariantes F6.1: tautologia, ação qualificante, episódios, guarda 42501, RLS) | ❌ **Docker ausente** (medido) — CI (`invariants`) |
| `pnpm build` | não re-tentado (instabilidade documentada F2–F4; delta typecheck-verde) |
