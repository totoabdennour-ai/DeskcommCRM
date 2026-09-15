---
type: our-product/phase-0-audit
doc: 09-multitenancy-audit
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d
evidence: supabase/baseline.sql (RLS), tests/invariants/, lib/impersonate/, lib/supabase/admin.ts
---

# 09 — Auditoria de multi-tenancy

## 1. Fronteiras por dimensão

| Dimensão | Mecanismo | Enforced por | Evidência |
|---|---|---|---|
| **Banco (RLS)** | `organization_id` + policies via `fn_user_org_ids()` (SECURITY DEFINER; memberships ativas UNION suporte ativo) | **CÓDIGO + TESTES** | `rls-isolation` (2 orgs, JWT simulado, zero vazamento), `rls-completude-varredura` (deriva tabelas do catálogo; nasceu de policy sabotada `or true`), 134 policies |
| **API** | `requireRole` (papel do banco), org de fonte confiável, `resolveActiveOrg` contra memberships | CÓDIGO + invariantes Gov G1-G8 | 241 call sites; amostragem confirma padrão |
| **Service role** | Regra: filter manual de org, nunca do body | **DISCIPLINA** (149/270 rotas; sem gate de escrita) — mitigado por invariantes comportamentais por-handler (`mcp-nao-alcanca-outro-tenant` roda SEM RLS para provar defesa em profundidade) | doc 08 R1 |
| **Storage** | 5 buckets; 4 privados com policies org-scoped (`ai-policy` por membership, `lgpd-exports` por prefixo, `skill-assets`, `whatsapp-media` **sem policy nenhuma = só signed URL/service role**); `brand-logos` público-por-design (logo exclusivo, path uuid não-enumerável, SVG banido, 512KB) | CÓDIGO + TESTES (`marca-logo` invariant) | migrations 0014/0017/0158 |
| **Worker/AI context** | job org-scoped; token efêmero TTL 300s com `actor:ai_agent`; tools filtram `ctx.organizationId` | CÓDIGO + invariantes (`rag-acervo-da-organizacao`, `agenda-mcp-nao-alcanca-contato-alheio`) | — |
| **RAG** | chunks org-scoped; RPCs de busca recebem org; versionamento por org | CÓDIGO + TESTES | — |
| **Integrações/secrets** | `tenant_integrations` por org; tokens cifrados (AES-256-GCM pgcrypto/AI_CRED_AES_KEY); segredos de webhook por sessão | CÓDIGO | `fn_encrypt_oauth` |
| **Impersonation/suporte** | Grant no BANCO (`fn_start_support`: AAL2, TTL 3600, sessão única), cookie HMAC só carrega o espelho; RLS admite a org só com sessão ativa; support_readonly = viewer | CÓDIGO + edge verification | `fn_start_support`, `fn_user_org_ids` |

## 2. Cenários de vazamento ainda plausíveis (honestos)

1. **Handler/MCP tool novo** com `createAdminClient` e sem `.eq('organization_id')` — todos os gates verdes; é o cenário nº 1 e o mais barato de fechar (varredura/lint no estilo dos guards existentes). Todo tool MCP novo herda o risco pelo mesmo caminho.
2. **`requireRole({organizationId})`** confia que o caller passou org de fonte confiável — nada enforca; um novo handler que passe org do body burla (a convenção é clara; a exceção seria silenciosa).
3. **`x-forwarded-for` spoofável** para buckets de rate limit (impacto confinado ao isolamento de bucket, não ao limite por conta).
4. **RAG/knowledge**: bem coberto por invariantes; risco residual é o mesmo da classe (1) — handler novo.
5. **Realtime**: postgres_changes respeita RLS com o JWT do browser (token callback corrigido após downgrade silencioso para anon — incidente documentado no hook); segurança depende do token estar sempre atualizado (há teste/regression no `lib/supabase/browser.ts`).

## 3. Veredito: é production-grade para múltiplos negócios?

**Sim para o produto atual, com UMA ressalva estrutural.** O isolamento de dados (RLS + testes de catálogo em CI) é incomum de forte para o segmento; a régua é aplicada a TODA tabela nova por varredura, o que torna o "esqueceram a RLS" impossível de passar despercebido. A ressalva é o **service role por disciplina** (149 rotas + 60 tools MCP): o risco não é o código atual (amostrado correto, invariantes comportamentais cobrem os caminhos críticos), é o **custo marginal de novos handlers** durante a transformação B2B — cada rota/tool de pedido novo é uma oportunidade de vazar cross-tenant sem gate. RECOMENDAÇÃO: antes da Fase 4 (Order Engine), tornar a regra em gate (`tests/unit/varredura-org-em-handlers-admin.test.ts` estilo `cron-audita-so-quando-ha-efeito`: varre handlers com `createAdminClient` e exige `.eq("organization_id"` ou justificativa allowlist). Risco de migration: nenhum (é gate de código, não de schema).
