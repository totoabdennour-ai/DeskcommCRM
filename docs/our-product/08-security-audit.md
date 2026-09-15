---
type: our-product/phase-0-audit
doc: 08-security-audit
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d
evidence: lib/auth/, lib/mcp/auth.ts, lib/sentry/scrub.ts, tests/invariants/, docs/threat-model.md (2026-07-29, re-verificado)
---

# 08 — Auditoria de segurança

## 1. O que está BEM (meios acima da média para CRM open-source — CONFIRMADO)

- **Sessão**: `getUser()` em toda decisão de auth (JWT validado no backend); o único `getSession()` é uso não-auth comentado (`realtime-token`). Permissões **fail-closed e ruidosas** (`auth_permissions_unavailable` em erro de DB).
- **RBAC**: `requireRole` resolve papel do **banco** (`fn_user_role_in_org`) — 241 call sites; lint custom (`lint-role-rank`) proíbe comparação manual de rank; `requirePlatformAdmin` com AAL2 condicional; negação audita `authz.denied`.
- **Org nunca do body**: cookie validado contra memberships; webhook→row; bearer→hash→row; path token→row. Amostragem de 3 handlers service-role confirma o padrão.
- **HMAC em tempo constante em 16 módulos** (WAHA SHA-512 por sessão fail-closed, Meta SHA-256, Nuvemshop SHA-256, convite, impersonation com secret ≥32 chars + TTL 1h + verificação edge, MCP, interno). Caddy bloqueia a rota global de webhook WAHA na borda.
- **RLS provada em CI** (doc 09) + varreduras de hardening: nenhuma SECURITY DEFINER executável por anon; funções novas nascem revogadas (doutrina das DUAS origens de EXECUTE).
- **LGPD real**: anonimização irreversível em cascata (contato+conversas+mensagens+mídia do storage+atividades), consentimento por finalidade, SLA D+7/D+15 vigiado, export assinado (PAdES opcional), redact de storage em fila idempotente.
- **Audit append-only do schema** (GRANT sem UPDATE/DELETE para ninguém) + retenção executada (expurgo service-role-only, piso 90d) + crons auditam só quando há efeito (guard AST cobre rotas futuras).
- **SSRF duas camadas** (texto + DNS com todas as famílias, fail-closed) e o E2E que o prova **agora roda no CI** (`e2e.yml:284`).
- **Sentry scrub único** (headers por padrão, PII regex, tokens de path redigidos), sem CSP mas com nosniff/DENY/Referrer/Permissions-Policy; `dangerouslySetInnerHTML` só 4 usos, todos por allowlist que rejeita `<`.

## 2. Disposição dos riscos T1–T7 do threat-model de 2026-07-29 (re-verificado no código de hoje)

| Item | Estado hoje | Evidência |
|---|---|---|
| T1 rate limit em auth | **MAIORIAMENTE RESOLVIDO** — login (IP 60/5min **+ lockout por conta** 5 falhas/5min), signup, reset, recovery de org, aceite de convite, captação, logo, dispatcher IA | `lib/auth/rate-limit.ts` + call sites em `signInWithPassword/signUp/requestPasswordReset/recoverOrganization/accept-invite` |
| T2 fallback in-memory | **PARCIAL** — Upstash agora `required()` em produção (boot falha); `peekRateLimit` toma o máx dos dois contadores; resta degradação por-processo se Redis cai | `lib/env.ts:170-171`, `lib/ai/dispatcher/rate-limit.ts` |
| T3 service-role sem gate de escrita | **ABERTO** — 149/270 arquivos de rota importam `createAdminClient`; **nenhum gate automático** (sem ESLint rule, sem sweep); o próprio teste admite "não afere que o .eq('organization_id') está lá" (`tests/unit/escrita-em-organizations-usa-cliente-admin.test.ts:30`) | ver doc 09 |
| T4 dev-fallback do convite | **ABERTO EM CÓDIGO** — `INVITE_TOKEN_SECRET ?? INTERNAL_SECRET ?? "dev-fallback"` (`lib/auth/invite-token.ts:17-18`); mitiga: `INTERNAL_SECRET` derruba boot em prod; `INVITE_TOKEN_SECRET` fora do contrato de env | — |
| T5 secrets fora do .env.example | **RESOLVIDO** + guard `env-example-sync.test.ts` | — |
| T6 SSRF E2E fora do CI | **RESOLVIDO** | `e2e.yml:284` |
| T7 sem secret scanning | **ABERTO E PIOROU** — sem gitleaks/trufflehog; PNGs rastreados subiram 116 → **363** (repo público self-host; screenshots de conversas reais) | `git ls-files '*.png' \| wc -l` |

## 3. Riscos atuais, ranqueados (leitura de 2026-09-14)

| # | Risco | Severidade | Evidência |
|---|---|---|---|
| R1 | Handler service-role novo sem filtro de org nasce com todos os gates verdes (sem gate de escrita; MCP roda tools sobre `createAdminClient` por design) | **HIGH** | doc 09 §3 |
| R2 | **CPF com hash SHA-256 sem salt** (keyspace ~10^11 com check-digit — pseudônimo, não segredo); RPC `encrypt_cpf` **não existe** no schema; `CPF_ENCRYPTION_KEY` obrigatória em prod mas referenciada por nada | **HIGH (LGPD)** | `lib/contacts/cpf.ts:17-40`; grep zero `encrypt_cpf` |
| R3 | Dev-fallback do convite + `INVITE_TOKEN_SECRET` fora do contrato de env | MEDIUM | `lib/auth/invite-token.ts` |
| R4 | Sem rate limit em: 22 crons, `/api/internal`, `/api/mcp` (enumeração de bearer), webhooks HMAC, `/auth/confirm`, `/api/v1/system/*` | MEDIUM | §2 do relatório de segurança |
| R5 | Sem CSP e sem HSTS (app e Caddy); brand-logos é o único bucket público (mitigado: exclusivo de logo, path não-enumerável, SVG banido, 512KB) | MEDIUM | `next.config.ts:55-82`; `Caddyfile` sem headers |
| R6 | Fallback in-memory do rate limit quando Redis cai (loud warn; Upstash required em prod) | LOW-MED | — |
| R7 | Sem secret scanning; 363 PNGs de evidência sem revisão de PII | LOW-MED | — |
| R8 | `getSession()` em uso cosmético não-auth | LOW | — |

## 4. Custo de correção (para o plano, sem executar aqui)

R1 = teste de varredura ou lint rule (barato, determinístico — o padrão já existe em `lint-role-rank`/`cron-audita`); R2 = provisionar `encrypt_cpf` (migration + backoff do hash) ou assumir hash-pseudônimo documentado; R3 = apagar o literal (trivial); R4 = aplicar `checkRateLimit` por prefixo no proxy (uma passada); R5 = headers no next.config/Caddy; R7 = gitleaks no CI + política de revisão de PII. Nada disso bloqueia a transformação, mas R1/R2 entram na Fase 1 (Fundação) desta auditoria — doc 16.
