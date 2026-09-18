---
type: our-product/phase-5
doc: 27-phase-5-agents-completion-report
status: final
created: 2026-09-17
baseline: Fase 4 commitada (9f71999c) + F4.1 na árvore
principle: "IA é interface; resolver/RPC/banco são a verdade (D4/D20/B1)."
---

# 27 — Relatório de conclusão da Fase 5 (Sales & Order Agents)

## 1. Auditoria da arquitetura de IA (o que JÁ existia — nada refeito)

| Capacidade | Estado | Veredito |
|---|---|---|
| Agent engine 24/7 (turno completo: contexto → router → tool loop → before-send → handoff) | `lib/agent-engine/` — inbound-turn, intent router com parse anti-alucinação, tool circuit breaker, ephemeral tokens (TTL 300s), budget por org | **REUSAR AS-IS** |
| Guardrails before-send v6 (9 gates: opt-out, LGPD, pacing, spinning, promessa determinística+semântica, case-promise, vazamento interno, disclosure) | `lib/agent-engine/guardrails/before-send.ts` | **REUSAR** — a promessa de preço do agente B2B já nasce vetada pela promise-table |
| Handoff humano | Determinístico pré-modelo (regex+keywords), `contacts.force_human`, demandas com dono, roteamento por canal; `request_human_handoff` nativa (BLOCKED no MCP) | **REUSAR** |
| Catálogo/busca | `crm_search_products` com avisos de empate/relaxamento calibrados em corpus real | **REUSAR** |
| Price authority | Resolver F3 (`consultarPreco`) + snapshot F4 — IA nunca lê catálogo cru para cotar | **REUSAR** (F4.1 já fechou bypass) |
| Order tools | `crm_create_order` (draft-only, ai_operator, recusa modelada) + `crm_get_order` (F4) | **REUSAR + EXTEND** |
| Prompt/behavior system | Playbooks versionados (plataforma→tenant→campanha) semeados de `platform.md` + skills | **REUSAR + EXTEND** (seção B2B) |
| Customer resolution | `wa_identity` + `contacts.account_id` (0239) + merge operador | **REUSAR** |
| **Contexto de conta no turno** | **AUSENTE** — `get_lead_context` não expõe conta/lista/rascunho; o agente não conseguia produzir o `account_id` que `crm_create_order` exige | **BUILD (tool)** |
| **Atualização de rascunho via conversa** | **AUSENTE** — PATCH REST existe, tool não | **BUILD (tool)** |
| **Gatilho de escalação por tipo de recusa** | **AUSENTE** — recusa era indiferenciada | **BUILD (puro + flags)** |

**Conclusão da auditoria: NÃO existe segundo framework.** A Fase 5 são 2 tools novas + 1 função pura + 1 seção de playbook + registros — o comportamento de agente emergiu do framework existente.

## 2. Componentes construídos

1. **`crm_get_order_context`** (read, agent, pacote `pedidos`): dado `contact_id` → resolve contato (org-scoped) → **conta** (`contacts.account_id`), lista de preço dela, **rascunho aberto com linhas**, últimos pedidos. Sem conta → `conta: null` + instrução **"NÃO invente conta"**; sem contato → `contato_inexistente`. É a resolução de identidade/estado que o turno não tinha.
2. **`crm_update_order_draft`** (write, **ai_operator**, pacote `pedidos`): substitui as linhas de um rascunho via `editarRascunho` (RPC 0241 — draft-only, same-org, re-resolve preço). Recusa modelada: `pedido_inexistente`, `nao_e_rascunho` ("NÃO prometa alteração de confirmado"), `conta_inexistente` (escala), recusas de preço com o flag determinístico (abaixo).
3. **`classificarRecusaDePedido(motivo)`** (`lib/orders/tipos.ts`, PURA): `conta_inexistente` e `moeda_mista` → `escalar_para_humano: true` (identidade/preço não se resolvem na conversa); `produto_inexistente/inativo/fora_da_lista` → false (o agente explica e oferece alternativa pela busca). Usada pelos DOIS handlers de escrita — o flag é determinístico e testado; a IA lê, não decide.
4. **Playbook plataforma — seção "Pedidos no atacado (B2B)"**: papel (opera rascunho), capacidades (as 5 tools na ordem do ciclo), proibições (nunca calcula/estima preço; nunca confirma/cancela; não inventa conta/substituto), regra do flag `escalar_para_humano` → `request_human_handoff`, regra "rascunho ≠ fechado, fechamento é do time". **Zero literal de preço** (gate).
5. Registro completo: metadata leigo-friendly, `index.ts`, `ALVO_DE_FUNIL` (`crm_update_order_draft: "sem_funil"` — pedido é da conta), pacote `pedidos` (agora 4 tools: 16+4=20 ≤ teto, gate passa).

## 3. Orquestração da conversa (a fronteira determinística)

O fluxo pedido é o turno existente, com os pontos determinísticos marcados:

```
Inbound → identidade (RPCs 0239, intocado)
→ contexto: crm_get_order_context (conta/lista/rascunho — DETERMINÍSTICO)
→ intenção/extração: o modelo lê a conversa e produz produto+quantidade (SÓ isso)
→ elegibilidade: tool_ids + BLOCKED_TOOL_IDS + pipeline scope (intacto)
→ tool call: crm_create_order / crm_update_order_draft
   └─ dentro: resolver F3 (preço) → RPC 0241 (estado+eventos, transacional)
→ resultado: recusa MODELADA com motivo + flag de escalação (nunca throw cru)
→ resposta: só números vindos da tool; prompt proíbe estimar
→ audit/event: auditMcpToolCall + order_events/event_log (F4, intocado)
→ handoff: flag escalar_para_humano + gatilhos nativos (keywords/jailbreak/budget)
```

## 4. Matriz de permissões das tools de pedido

| Tool | Papel | Escopo | Category | Confirma? | Recusa/falha |
|---|---|---|---|---|---|
| `crm_get_order_context` | agent | mcp:read | read | não | `contato_inexistente` / sem conta + instrução |
| `crm_search_products` (F0) | agent | mcp:read | read | não | avisos empate/relaxamento |
| `crm_create_order` | **ai_operator** | mcp:write | write | **NUNCA** (draft) | recusa modelada + `escalar_para_humano` (determinístico) |
| `crm_update_order_draft` | **ai_operator** | mcp:write | write | **NUNCA** (só draft) | idem + `nao_e_rascunho` |
| `crm_get_order` | agent | mcp:read | read | não | `encontrado: false` |
| `crm_request_human_handoff` | — | — | — | — | **BLOCKED no MCP** — handoff é nativo do turno |

Autorização de mutação: token efêmero `mcp:write` + `ai_operator` + RLS + RPC same-org + `auditMcpToolCall`. Nenhum caminho AI-only novo.

## 5. Condições de handoff (explícitas e testáveis)

Determinísticas em código: `conta_inexistente`, `moeda_mista` (classificador puro, `tipos.test.ts`); pedido sem conta no update (`escalar_para_humano: true` no handler). Do playbook (instrução ao modelo, com gate de conteúdo): flag de escalação → `request_human_handoff`; pedido confirmado não se altera → escalar. Nativos intactos: cliente pede humano, jailbreak, budget, sentimento.

## 6. Testes e resultados EXATOS (Node 22.23.2 portátil)

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` | ✅ **verde** |
| `pnpm lint` | ✅ **0 erros** (356 warnings pré-existentes) |
| Lote F5 (10 arquivos) | ✅ **278/278**: pedidos.test 8 (contexto org-scoped/sem conta/rascunho com linhas; update draft/confirmado/moeda_mista-escala/produto_inativo-não-escala/sem conta-escala), tipos (classificador 2), playbook B2B gate 5, playbook-cita 3, leigo-friendly (23 tools), capacidade-alcancavel, escopo-de-funil, pacote-reserva, comercio.test, orders route (idempotência transacional) |
| `pnpm test:unit` (completa) | resultado consolidado ao fim da rodada (§8) |
| `pnpm test:db` | ❌ Docker ausente — CI |
| `pnpm build` | não re-tentado (instabilidade documentada F2-F4) |

**Cenários pedidos × onde estão provados**: inquiry/identificação/preço → `crm_search_products` (F0, corpus real) + `crm_get_order_context`; draft multi-item → `criarRascunho` (F4 route+tool); missing quantity → Zod `min(1)`; no_price/unknown SKU → recusa modelada com motivo (F4) + flag; duplicate call → Idempotency transacional (F4.1, invariante); AI confirmation → inexistente por construção (nenhuma tool; rota manager+) e gates `capacidade-alcancavel`/`escopo-de-funil`/leigo-friendly cobrem as novas; invented price → schema descarta + playbook gate proíbe literal; cross-tenant → org-scoped nos handlers + invariantes F4; handoff → classificador + flags (esta fase); tool failure → recusa modelada; resultado refletido → testes de handler com total do engine.

## 7. Segurança (validação)

Zero caminho AI-only de autorização: as tools novas passam pelo MESMO `auditMcpToolCall`/efêmero token/RLS/RPC das antigas; `BLOCKED_TOOL_IDS` intacto; nenhuma mutação direta de tabela pelo modelo; before-send intocado (promessa de preço na MENSAGEM segue vetada pela promise-table).

## 8. Limitações conhecidas

- A extração de rascunho a partir de PDF/áudio (multimodal) não entra nesta fase — as tools já aceitam o resultado quando a F6 entregar o parser.
- O playbook é plataforma (todas as orgs leem); personalização por vertical é tenant-layer na tela (F7/piloto).
- `crm_get_order_context` requer `contact_id` explícito — a amarração automática turno→contact já existe no engine (intocada).
- Sem test:db/build local (limitações de ambiente já documentadas) — CI cobre.

## 9. Dependências legadas para o Recovery Engine (F8)

Nada desta fase bloqueia a F8: o Recovery consumirá `crm_get_order_context`/orders history e o motor de follow-up existente; os flags de escalação (`classificarRecusaDePedido`) são o molde para os gatilhos de recuperação determinísticos.
