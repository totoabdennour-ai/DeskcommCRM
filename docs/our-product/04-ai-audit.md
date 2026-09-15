---
type: our-product/phase-0-audit
doc: 04-ai-audit
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d
evidence: lib/agent-engine/, lib/ai/, lib/mcp/, workers/agent-worker/
---

# 04 — Auditoria da arquitetura de IA

## 1. Provedores e seam único (CONFIRMADO)

- SDK `ai ^7.0.96` + `@ai-sdk/{anthropic,openai,google}` + OpenRouter; Zod 4.
- **Todo call de LLM passa por `runModelCall`** (`lib/agent-engine/edge/llm/run-model-call.ts`, 673 l.): resolve config da org → modelo por "ponto" (propósito) → **orçamento mensal atômico** → `generateText` → persiste tokens/custo em `llm_calls` (sucesso **e** falha). Nenhum call site instancia provider direto.
- Credenciais **BYOK por org**: `ai_provider_credentials` (AES-256-GCM, `lib/crypto/aes_gcm.ts`), fallback para chaves de ambiente. Config re-lida do banco **a cada chamada** — trocar modelo não exige restart.
- Seleção de modelo em 5 níveis (`lib/ai/pontos/resolver.ts`): fixo de produto → agente publicado → binding por ponto (`ai_purpose_bindings`, painel de provedores) → env knob → default da org. **23 pontos registrados** (`lib/ai/pontos/registro.ts`) com teste de completude.
- Catálogo de modelos: `ai_models`/`ai_pricing` sincronizados do OpenRouter por cron diário (`sync-model-catalog`), preço→cents/milhão arredondado para cima, deprecate-never-delete.
- Caminho legado paralelo: `lib/ai/gateway.ts` (Vercel AI Gateway) ainda alimenta `ai-response-worker`/sentiment — dois caminhos de IA (dívida).

## 2. Prompts, memória e contexto (CONFIRMADO)

- Playbooks versionados imutáveis (`playbook_versions` — trigger veta UPDATE; ponteiro publica) em camadas **plataforma → tenant → campanha**; o `system_prompt` do agente publicado entra como camada tenant. Ordem de composição: playbook → memória da org → índice de skills → transparência (disclosure de IA) → casos/agenda. Prefixo byte-determinístico para cache de prompt (`LLM_CACHE_TTL`).
- **Memória em 3 níveis**: org (`org_memory_entries`, manual ou flywheel), conversa (`lead_checkpoints` — compromissos/objeções/next_action/rolling_summary escritos por chamada de fechamento), lead (`lead_notes` — headline no prompt, corpo sob demanda). Compaction com modelo barato + poda de tool results.
- Skills = playbooks situacionais com matcher determinístico (keywords), corpos injetados por lead; near-misses viram golden-candidates (corpus de calibração versionado em `lib/agent-engine/golden-candidates/`).

## 3. Tools e autorização (CONFIRMADO)

- **10 tools nativas** do runtime (`AGENT_TOOL_DEFS`, inbound-turn.ts:182): `get_lead_context`, `send_message` (única via de mensagem), `send_template`, `update_lead_state`, `schedule_followup`, `save/get_lead_note`, `search_knowledge`, `request_human_handoff`, `read_skill_reference`, `open_human_case`/`provide_case_update`.
- **60 tools MCP** em 9 domínios (`lib/mcp/tools/catalogo/*.ts`): funil (create/move/list leads), contatos, conversas, agenda, governança, evolução, **comércio** (`crm_search_products`, `crm_list_contact_orders`), operação, retenção. Nomes são contrato público ("nunca renomeie tool publicada").
- Autorização: `ai_agent_versions.tool_ids` + `pipeline_ids` (escopo de funil; **omitido = nenhum**), token efêmero TTL 300s com scopes `mcp:read/write` + `actor:ai_agent`, `BLOCKED_TOOL_IDS = {crm_send_whatsapp_message, crm_request_human_handoff}` (envio e handoff são sempre caminho do harness), circuit breaker de tool, audit por chamada em `api_audit_log`.
- **Saída estruturada**: apenas 1 `generateObject` no repo (sentiment). Todo o resto é `generateText` + parse tolerante + Zod a posteriori (declaração do turno `.strict()`, router de intenção anti-alucinação).

## 4. Guardrails, custo e observabilidade (CONFIRMADO)

- Cadeia **before-send v6** (1.238 l., forma travada por teste de CI): stop/opt-out → LGPD → pacing anti-ban (janela 7-22h, caps por warm-up) → janela do agente → spinning (anti-repetição) → promessa determinística (tabela versionada `minPriceCents`/`maxDiscountPercent`/`maxInstallments` — **o único controle de preço que existe**, e é de saída de mensagem, não de transação) → promessa semântica (classificador barato) → case-promise (anti-alucinação) → vazamento de vocabulário interno → disclosure de IA. Todo veredito rastreado em `before_send_traces`; fail-safes com limite de vetos (nunca deixar cliente sem resposta).
- Orçamento: `ai_budgets` por org, enforcement off/warn/block com carência, gastos por `fn_gasto_de_ia_do_mes` sobre `llm_calls.cost_cents`; estouro = aviso ao lead + handoff humano escortado. **Preço de token coberto só para prefixos Claude** — modelo desconhecido → cost NULL → "gasto incompleto" honesto.
- Jailbreak classifier + correlação com promessa fora da tabela → escalar para Central.
- Observabilidade: Sentry (erro-only no DSN da comunidade), `/healthz` + `/metrics` no worker, telemetria rica (`llm_calls`, `before_send_traces`, `knowledge_searches`, `skill_activations`, `ai_router_decisions`, `send_ledger`), telas de Runs/Uso/Evolução.

## 5. Handoff e roteamento (CONFIRMADO)

Gatilhos: regex determinístico pré-modelo + keywords do agente, tool `request_human_handoff`, opt-out ambíguo, estouro de orçamento, gates G1–G4 legados (humano/confiança/jurídico/sentimento<0.3). Efeito: `contacts.force_human=true` + `bot_silenced_until='infinity'` + follow-ups cancelados + item na Central + aviso ao lead **antes** do silenciamento; agente nunca retoma (só humano ou `crm_resume_ai_attendance`). Atribuição: `lib/routing/` (rodízio real, elegibilidade, fila com backoff, políticas **por canal** 0228 com RPC serializado).

## 6. Adequação aos 4 agentes-alvo

| Agente-alvo | O que reusa | O que falta | Veredito |
|---|---|---|---|
| **AI Sales Agent** (venda consultiva B2B) | Turno completo, RAG, skills, guardrails de promessa (tabela já tem piso/preço/máx desconto), follow-up, handoff | Contexto de **conta B2B** (histórico de pedidos, condições comerciais) no prompt; tools de cotação | **ADAPT** — a base é forte; falta injetar domínio |
| **AI Order Agent** (capturar pedido da conversa) | Tool loop com Zod, `crm_search_products` (busca token-wise validada em corpus real, avisos de ambiguidade/empate), `crm_list_contact_orders`, checkpoint/declaração | **Tudo do lado de escrita**: nenhum schema de extração de pedido, nenhuma tool `crm_create_order`, sem `order_items`, sem validação de MOQ/preço por conta, sem estoque-reserva | **EXTEND** sobre primitivas boas — não REBUILD |
| **AI Support Agent** | Demandas (casos com dono sempre presente), cases, skills, handoff | — | **KEEP** |
| **AI Revenue Recovery Agent** | Radar de leads em risco, reativação com expiração, follow-up adaptativo, métricas | Detecção **monetária** (orders × silêncio × estágio), motor de recovery events, join receita | **EXTEND** |

## 7. Gaps técnicos concretos (evidência)

1. **Sem extração estruturada de pedido** — o padrão do repo é "parse tolerante + Zod"; para pedido é recomendável introduzir o segundo `generateObject` do repo (schema de pedido rascunho → validação → confirmação humana/agente) — RECOMENDAÇÃO.
2. **Preço por conta inexistente** — o agente só consegue cotar `catalog_products.preco_cents`; desconto é vetado pela tabela de promessas, não calculado.
3. **`custo_cents` (piso de custo) existe e não é lido por ninguém** (0204) — fio pendente exatamente para a regra de desconto B2B.
4. **RAG de catálogo vivo**: o consumidor `nuvemshop.product_synced` existe, o emissor não — sincronia catálogo↔RAG é meia-ponte pronta.
5. **MCP sem cliente HTTP** — para agentes externos (Claude Desktop etc.) o servidor MCP público já funciona; o interno chama in-process. Manter assim no MVP (menos superfície).
6. **Custo de tokens**: cache de prefixo estável já implementado; compaction e budgets por org prontos — custo marginal de agentes novos é controlável por design.
7. **Multimodal**: imagem/PDF nativo só para a ÚLTIMA mensagem inbound e modelos com capacidade; derivação de PDF corta em 8.000 chars — PDF de pedido multi-página é truncado silenciosamente (ver doc 05).
