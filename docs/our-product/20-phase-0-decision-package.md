---
type: our-product/phase-0-audit
doc: 20-phase-0-decision-package
status: final — pacote de decisão para revisão do dono
created: 2026-09-14
synthesizes: 11, 12, 13, 15, 16, 17, 18, 19, DECISIONS.md (nenhum deles foi alterado)
audited_at_commit: 5c132f4d
type_note: "RECOMENDAÇÃO salvo marcado CONFIRMADO (código/doutrina). Nada implementado."
---

# 20 — Pacote de decisão da Fase 0

Responde EXATAMENTE às 12 perguntas do review. Evidência resumida inline; profundidade nos docs citados.

---

## 1. Reusar a tabela `orders` ou criar tabela nova? 

**RECOMENDAÇÃO FORTE: REUSAR `orders`, com mudança de contrato mínima.** (DECISIONS.md D3; docs 03/06)

Evidência que decide:

1. **4 leitores vivos já apontam para ela** — `crm_list_contact_orders` (MCP, `lib/mcp/tools/comercio.ts:39`), painel CRM do inbox (`app/api/v1/contacts/[id]/crm-summary/route.ts:96`), export LGPD (preserva TOTAIS na redact por decisão existente) e stats admin (`app/api/v1/admin/tenants/[id]/route.ts:81`). Tabela nova = reescrever/repontar os 4 + duplicar LGPD.
2. **O contrato de espelho é extensível, não hostil**: unique `(organization_id, external_provider, external_id)` (baseline:2341) é exatamente a idempotência que o pedido nativo precisa; basta o CHECK ganhar `manual`/`internal` + coluna `origin`.
3. **A migration 0204 já registrou o caminho**: o header dela afirma que a Nuvemshop "ganhará o escritor que hoje lhe falta" — o desenho do banco já esperava `orders` virar escrita.
4. **Convenções de dinheiro herdadas de graça**: `_cents` + currency, moeda de nascimento preservada (0208 pensou orders para isso), `is_anonymized` LGPD já previsto.
5. **Custo da alternativa**: tabela nova reabre RLS nova, sweep de catálogo, redact cascade, painéis e export — 1-2 sprints de trabalho só de pontes, mais uma fonte permanente de divergência ("qual tabela é o pedido?").

Riscos gerenciáveis: CHECK novo exige dedup/verificação de dados ANTES (doutrina do repo, baseline idempotente); leitores existentes precisam filtrar `origin` para não confundir espelho com pedido nativo. Mitigação explícita no doc 14 (invariantes 1-8).

## 2. Comportamentos do protótipo n8n a preservar

Dos 11 comportamentos mapeados (doc 11), preservar TODOS como requisitos — mas 6 já existem em código melhor do que o workflow faria:

| Comportamento | Destino na nova arquitetura |
|---|---|
| Customer resolver | **JÁ EXISTE** — RPCs atômicos `fn_upsert_wa_contact` + merge operador (`fn_mesclar_contatos`); preservar como está |
| Channel identity | **JÁ EXISTE** — HMAC → normalização → unique DEFERRABLE (org, external_id); preservar |
| Order create (da conversa) | **CONSTRUIR** — rascunho → confirmação → pedido confirmado com itens imutáveis (Order Engine, Fase 4) |
| Order lifecycle | **CONSTRUIR** — transições válidas, cada uma emite evento (`order_events`) no mesmo commit |
| Order modification | **CONSTRUIR** — emenda = evento novo com delta; itens confirmados nunca UPDATEados; total calculado dos itens |
| Idempotency | **CONSTRUIR server-side** — `Idempotency-Key` honrado na rota de pedido (infra `idempotency_keys` já existe, usada em 4 rotas) |
| Audit/event logging | **JÁ EXISTE** — append-only por GRANT + guard AST; estender "audita quando há efeito" às rotas de pedido |
| Human handoff | **JÁ EXISTE** — IA nunca retoma após handoff; aviso ao lead antes do silêncio; preservar |
| AI escalation | **JÁ EXISTE** — gatilho determinístico pré-modelo + budget-escort; preservar |
| Notifications | **JÁ EXISTE** — Central (agent_inbox_items) + web push dedupados por episódio; preservar |
| Retry/failure recovery | **CONSTRUIR o ledger** — `sync_ledger` (irmão do `send_ledger`) para ERP; dead-letter COM alerta (hoje event_log morre em silêncio) |

**Pendente do dono (bloqueia Fase 4, não Fase 1)** — detalhes de regra que só o export dos workflows responde (doc 11): comportamento de falha com MOQ/crédito (rejeita? escala?), substituição de SKU, chave de identidade além de telefone, modelo de preço por cliente, janela de corte de pedido.

## 3. KEEP / ADAPT / EXTEND / REBUILD / REMOVE / INTEGRATE

Condensado da matriz completa (doc 12):

- **KEEP (18)**: multi-tenancy+RLS; auth/RBAC/MFA/impersonation; conversas/inbox; canais WhatsApp (WAHA+Meta+Zernio); agent-engine (turno, guardrails, fila, pacing, budget); RAG; MCP server; CRM funil; automações (7 ações); follow-up+radar; agenda+Google; LGPD; métricas base; self-host kit; white-label; prd/docs; CI 5 checks; eventos (event_log+job_queue como primitivos).
- **ADAPT (4)**: `orders` (espelho→nativo com `origin` — Q1); promise-table (knob global→política por conta); multimodal (cap 8k chars, visão de "captura de pedido"); `conversations.channel` CHECK (só quando multicanal real).
- **EXTEND (4)**: `catalog_products` (unidade, listas, vínculo a itens); RAG de catálogo (alimentar consumidor órfão `nuvemshop.product_synced`); métricas (receita = pedido, não value digitado); radar (valor em risco, não só temperatura).
- **REBUILD (4)** — construção nova: Order Engine (`order_items`, `order_events`, lifecycle, idempotência); Pricing (`price_lists`, `account_prices`, MOQ); Accounts (empresa B2B, condições, rep); ERP Gateway (doc 10).
- **REMOVE (1)**: caminho legado de IA (`lib/ai/dispatcher` + `ai-response-worker`/`ai-handoff-from-sentiment`) após migração dos últimos pontos — dois caminhos por feature de IA é dívida contínua. Fase 10, não agora.
- **INTEGRATE (1)**: n8n — **não**; permanece ferramenta opcional do operador via webhooks de saída (Q10).

## 4. O que a Fase 1 DEVE modificar

Fundação antes de dinheiro — 9 itens pequenos e independentes (doc 16 Fase 1; doc 19 Q15):

1. Dead-letter de `event_log` vira alerta (Central), espelhando o padrão de `job_queue`.
2. Eliminar emissão fire-and-forget de eventos (`void admin.from("event_log").insert(...)` nas rotas admin/agent actions) → emissão aguardada/transacional.
3. Gate automático de `organization_id` em handlers com `createAdminClient` (teste-varredura novo, estilo `cron-audita-so-quando-ha-efeito`).
4. Remover `"dev-fallback"` de `lib/auth/invite-token.ts`; `INVITE_TOKEN_SECRET` entra no contrato de env.
5. Rate limit por prefixo na borda (`proxy.ts`) cobrindo crons/`/api/internal`/`/api/mcp`/`/auth/confirm`.
6. CSP + HSTS (app e Caddy).
7. Gitleaks no CI + política de revisão de PII para evidências (363 PNGs).
8. **Decisão CPF** (R2): provisionar `encrypt_cpf` (migration única) OU documentar hash-pseudônimo como posição formal — o dono decide; não deixá-lo aberto.
9. Re-auditar `docs/threat-model.md` com os 5 checks verdes como aceite da fase.

## 5. O que a Fase 1 NÃO deve modificar

- **Nenhum comportamento visível de produto** — zero telas, zero UI, zero copy.
- **Nenhum schema além da decisão do item CPF** — nada de `accounts`, `orders.origin`, `order_items`, `price_lists` (Fases 2-4). Nada de apêndice no baseline exceto o (único, se aprovado) do CPF.
- **Nada no agent-engine** — `inbound-turn.ts`, guardrails, prompts, playbooks, tool catalog, budget: intocados (Fase 5).
- **Nada em canais/ingest** — `lib/waha/`, `lib/channels/`, templates, pacing (o produto atual não pode regredir).
- **Nenhuma tool MCP nova** (Fase 4-5).
- **Nenhum Docker/compose/kit** — packaging está correto e vigiado; não mexer sem necessidade.
- **Não remover o caminho legado de IA ainda** (REMOVE é Fase 10, após migração).
- **Não começar n8n/ERP** — não criar adapter, não criar sync.

## 6. Top 10 riscos arquiteturais/de segurança

| # | Risco | Sev | Doc |
|---|---|---|---|
| 1 | Service-role sem gate de escrita (149/270 rotas; handler/tool novo vaza cross-tenant com CI verde) | HIGH | 08/09 |
| 2 | CPF hash sem salt + `encrypt_cpf` não provisionado (LGPD) | HIGH | 08 |
| 3 | Mudança de contrato de `orders` com 4 leitores vivos (regressão silenciosa de painéis/LGPD) | M-H | 03/06 |
| 4 | Sem rate limit nas superfícies de secret (22 crons, `/api/mcp`, `/api/internal`, `/auth/confirm`) | MED | 08 |
| 5 | Sem CSP/HSTS (app e Caddy) | MED | 08 |
| 6 | Drain genérico usado como atalho para fluxo de dinheiro (sem SKIP LOCKED, dead silencioso) | MED (alto se ignorado) | 07 |
| 7 | ERP do piloto instável/lento (externo, incontrolável) — precisa sync_ledger como design de falha | MED-H | 10/17 |
| 8 | God-file `inbound-turn.ts` (4.083 l.) — agentes novos não podem crescer ali | MED | 02/15 |
| 9 | Sem secret scanning + 363 PNGs de evidência sem revisão de PII (repo público) | MED | 08 |
| 10 | Preço errado em pedido por IA = dano financeiro — mitigado por resolução SQL determinística + confirmação explícita (D4/D5) | MED-H de produto | 04/17 |

(Honrosos: dois caminhos de IA; moeda de relatório multi-moeda; liveness em Vercel.)

## 7. Arquitetura mínima viável para o piloto B2B (distribuição)

A que já existe **+ 4 peças novas, sem ERP**:

1. Plataforma atual intacta (tenancy, WhatsApp, agente, LGPD, self-host) — zero mudanças.
2. **Accounts mínimas**: `accounts` (nome, CNPJ/CPF opcional, condições em texto, rep = owner, MOQ, price_list_id) + `contacts.account_id` + tela simples (Fase 2).
3. **Pricing mínima**: 1 lista de preços por conta (`price_lists`+`price_list_items`), resolução override>lista>catálogo em SQL (Fase 3, sem desconto composto/por volume no piloto).
4. **Order Engine mínima**: `orders.origin`, `order_items`, `order_events`, idempotência server-side, estoque = `catalog_products.quantidade` (sem reserva séria no piloto) (Fase 4).
5. **Order Agent**: tool `crm_create_order` + rascunho→confirmação explícita na conversa; handoff para vendedor humano com o rascunho (Fase 5).
6. **Operação humana mínima**: fila de rascunhos→confirmar→marcar entregue na tela; notificações reusadas (Fase 7 mínima).

**De fora do piloto**: ERP adapter, recovery monetário, multimodal avançado (voz/imagem para pedido), multicanal, automações de comércio, comissão/cota de rep. Topologia de deploy inalterada (app+worker+scheduler+waha+redis+caddy).

## 8. O menor V1 útil sem virar ERP

**O "loop conversa→pedido→operação" e nada mais**: cliente B2B conversa no WhatsApp, o agente resolve conta/preço/SKU, monta o rascunho com itens, o cliente confirma, o pedido entra no sistema com itens/eventos/estado, o time do distribuidor opera (confirmar/expedir/entregar) e o funil/métricas passam a refletir receita real de pedido.

**Guardrails anti-ERP explícitos** (o que o V1 NÃO faz):
- ❌ Fiscal/invoice/imposto — o ERP é o sistema fiscal; nós geramos o pedido comercial.
- ❌ Logística (roteirização, frete, tracking próprio) — `tracking_code`/`fulfillment_status` existem para o ERP preencher.
- ❌ Armazém multi-CD, lote, reserva séria de estoque — quantidade do catálogo basta.
- ❌ Financeiro (contas a receber, crédito com scoring, boleto) — limite de crédito é um campo com bloqueio/alerta configurável.
- ❌ Compras/procurement, produção, devoluções/RMA, matriz de variantes, relatório multi-moeda.
- Regra de decisão (DIRC do repo + D8): **se a operação pertence ao "registro operacional" do ERP, ela é espelho/status — nunca reimplementada aqui.** Cada tentativa de feature nova passa por esta pergunta.

## 9. O que permanece externo

- **ERPNext** (e depois Odoo/ERP custom): sistema de registro operacional/fiscal — estoque verdadeiro, faturamento, impostos, entrega. Integramos por adapter REST de 8 operações (doc 10), clean-room (GPL: sem copiar código), credencial por org cifrada, sync_ledger com reconciliação. O pedido nasce aqui e espelha para lá; status volta por webhook/poll.
- **WAHA** (licenciado, tag fixa, nunca republicado) · **Meta Cloud API** · **Supabase** (Auth/Storage/Realtime) · **Redis/SRH** (efêmero, nunca no caminho de dinheiro) · **provedores de LLM** (BYOK) · **Resend/Sentry/Upstash/Google Calendar** como hoje · **Nuvemshop** (B2C de referência, sync opcional) · **n8n/Zapier** como ferramenta opcional do operador (Q10).

## 10. n8n fora do core? 

**CONFIRMADO — SIM, fora do core.** Três fundamentos: (a) 6 dos 11 comportamentos do protótipo já existem em código com garantias que o workflow não teria (dedup/RLS/ledger/audit — doc 11); (b) os 5 restantes são exatamente o Order Engine, cujos padrões têm precedente de arquivo no repo (`fn_create_tenant_with_owner`, `send_ledger`, `completeJob(inSameCommit)`); (c) n8n no core duplicaria o barramento fora do alcance dos invariantes de CI e do RLS-sweep, com banco/graph próprio para operar e atualizar. Zero artefatos n8n existem no repo (doc 01 §9) — nada a migrar, nada a remover. Ele continua consumível pelo operador via `webhooks/in/[token]` e acionável via ações `call-webhook` com SSRF guard.

## 11. Arquivos/módulos exatos da Fase 1

| Item | Arquivos |
|---|---|
| Dead-letter alerta | `lib/event-log/drain.ts` (+ handler de alerta reusando `agent_inbox_items`); teste em `tests/unit/` |
| Emissão transacional | `app/api/v1/admin/incidents/[id]/resolve/route.ts`, `app/api/v1/admin/tenants/[id]/suspend/route.ts`, `.../reactivate/route.ts`, `app/actions/onboarding/{createDefaultAgent,finishOnboarding}.ts`, `app/app/ai/agents/[id]/_actions.ts` |
| Gate org-filter | NOVO `tests/unit/varredura-org-em-handlers-admin.test.ts` (+ allowlist justificada, estilo `lint-role-rank`) |
| Dev-fallback | `lib/auth/invite-token.ts`, `lib/env.ts`, `.env.example` (+ `tests/unit/env-example-sync` se necessário) |
| Rate limit de borda | `proxy.ts`, `lib/auth/rate-limit.ts` (novos limites por prefixo), `lib/auth/public-paths.ts` (se mapear prefixos) |
| Headers | `next.config.ts`, `Caddyfile` |
| Secret scanning | `.github/workflows/ci.yml` (job gitleaks) |
| CPF | `lib/contacts/cpf.ts` + (se aprovada) UMA migration + apêndice baseline + MANIFEST — decisão do dono primeiro |
| Docs | `docs/threat-model.md` re-auditado |

## 12. Esforço relativo (SMALL / MEDIUM / LARGE)

| Item | Esforço | Base |
|---|---|---|
| Dead-letter alerta | **SMALL** | padrão `agent_inbox_items` pronto |
| Emissão transacional (8 call sites) | **SMALL** | mudança mecânica por arquivo |
| Gate org-filter (teste-varredura) | **SMALL-MEDIUM** | precedentes `lint-role-rank`/`cron-audita` |
| Dev-fallback do convite | **SMALL** | apagar literal + env |
| Rate limit de borda | **SMALL-MEDIUM** | infra existe; só prefixos |
| CSP/HSTS | **SMALL** (com risco de quebrar assets — testar telas) | headers declarativos |
| Gitleaks + política de PNG | **SMALL** | workflow declarativo |
| CPF (se criptografia) | **MEDIUM** | migration + backfill + cascade LGPD |
| Fase 2 Accounts | **MEDIUM** | tabela+RLS+telas+360 |
| Fase 3 Pricing | **MEDIUM-LARGE** | regra de resolução + telas |
| Fase 4 Order Engine | **LARGE** | o coração; invariantes de dinheiro |
| Fase 5 Agentes de pedido | **MEDIUM** | sobre base pronta |
| Fase 6 Multimodal | **MEDIUM** | caps/visão/parser |
| Fase 7 Operações humanas | **MEDIUM** | telas |
| Fase 8 Recovery | **MEDIUM** | detector + execução reusada |
| Fase 9 ERPNext adapter | **LARGE** | externo, clean-room, reconciliação |
| Fase 10 Hardening + REMOVE legado | **MEDIUM** | retenção/SLO/ensaio VPS |
| Fase 11 Piloto | — | conduzido com o cliente |

---

## Condição de parada

Este pacote é o único artefato novo da rodada de review. Nenhum documento anterior foi alterado; nenhum código, migration, refactor ou feature foi implementado. A Fase 1 começa somente após o dono aprovar este pacote e responder as OPEN QUESTIONS mínimas (CPF do item 4/6; as 5 regras de negócio do n8n do item 2 — estas bloqueiam a Fase 4, não a Fase 1).
