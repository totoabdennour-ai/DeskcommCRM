---
type: our-product/phase-2
doc: 23-phase-2-accounts-completion-report
status: final
created: 2026-09-16
baseline_commit: b3db4e77ae24b426eafd0ff48a4854d68db59bdd (Fase 1)
scope_source: pedido de Fase 2 do dono + docs/our-product/21 §8 (F2) + DECISIONS.md
---

# 23 — Relatório de conclusão da Fase 2 (Accounts)

## 1. Auditoria antes de codar (o que JÁ existia)

1. **Cliente/pessoa**: `contacts` é a pessoa física do tenant — rica e intocada: `wa_identity` (identidade de canal gerada phone/lid), `consent` por finalidade, `custom_fields` (definições em `crm_pipelines.settings.fields[]`), flags LGPD (`is_anonymized` irreversível), merge operador (`fn_mesclar_contatos`), opt-out (`is_blocked`). Zero lacunas aqui.
2. **Conceito de empresa/conta**: **INEXISTENTE** — confirmado por varredura do schema: nenhuma tabela/coluna de account/company (os únicos "account" eram `channel_sessions.zernio_account_id`, id de BSP, conceito alheio). A auditoria Fase 0 (docs 03/06) classificava "Customer Account (B2B)" como MISSING.
3. **Modelo tenant/org**: `organizations` (tenant) + `user_organizations` (4 papéis) + `platform_admins`. **Account ≠ tenant** — conta é a empresa-CLIENTE dentro do tenant.
4. **Relações/FKs existentes em contacts**: conversations (RESTRICT), crm_leads (SET NULL), demandas, calendar_appointments (RESTRICT), orders (SET NULL), voice_calls. Nenhuma aponta para empresa. `fn_mesclar_contatos` reponta FKs que APONTAM para contacts — `contacts.account_id` aponta DE contacts, imune ao merge.
5. **RLS**: molde canônico em três variantes; a escolhida foi a de `catalog_products` (0204/0177): **leitura org-flat + escrita `manager`+** — tabela é insumo comercial; `fn_role_at_least` + `fn_user_org_ids` + `fn_is_platform_admin`.
6. **Padrões reusados**: API = molde `products` (requireRole viewer GET / manager POST+PATCH, Zod compartilhado tela+rota, `audit()` com ação do vocabulário fechado, `ok()/fail()`, `traduzir`, route.test.ts com dublê de supabase); UI = molde products (page server + _client, `data-testid`, busca substring); navegação = catálogo (`group: "crm"`, seção "Preparar a venda", sem sidebar — atrás de "Ver tudo em CRM", como Produtos); i18n = dicionário pt→es com varredura AST no CI.
7. **Estender vs construir**: estendeu `contacts` (1 coluna) + `lib/schemas/contacts` (1 campo no PATCH) + `lib/types/contacts` (1 campo) + dicionário; construiu `accounts` (tabela/API/tela/schemas).
8. **Contradições com a síntese**: nenhuma. A síntese mandava "não inventar regras de identidade B2B" — respeitado (nenhuma resolução nova; a identidade de canal continua sendo `contacts.wa_identity`).

## 2. Arquitetura escolhida

`Tenant (organizations) → Account (accounts) → Contact (contacts, account_id opcional) → Channel Identity (contacts.wa_identity, intocado)`.

- **Conta é camada ACIMA de contacts, aditiva e opcional** — B2C e os nichos atuais seguem byte a byte (contato sem conta é o estado normal).
- **Ciclo de vida no banco**: `status` CHECK (`active|inactive|archived`); **não existe DELETE** na API — arquivar preserva contatos vinculados; se um DELETE direto no banco acontecer, `ON DELETE SET NULL` garante contato vivo sem vínculo (provado por invariante).
- **Autoridade no banco**: (a) `accounts_org_external_id_unique` parcial — referência externa única por org quando presente; (b) `fn_valida_conta_da_mesma_org` + `trg_contacts_valida_conta` — a FK simples não enxerga tenant, então o vínculo contato↔conta cross-org é RECUSADO no banco (23514), não só na API; (c) RLS manager-write; (d) `trg_accounts_updated_at` com `fn_set_updated_at`.
- **Sem AI/MCP**: nenhuma tool MCP nova, nenhum caminho de IA (a Fase 5 as receberá via `tool_ids` — o contrato de nomes congelados fica intacto).

## 3. Arquivos

**Migration (a tripla):**
- `supabase/migrations/20260915120000_0239_accounts_fundacao_b2b.sql` — nova.
- `supabase/baseline.sql` — apêndice idempotente `---- fundação B2B: accounts (migration 0239) ----` (create table if not exists, add column if not exists, índices, policies drop+create, função/trigger drop+create).
- `supabase/migrations/MANIFEST.md` — linha 0239.

**Domínio/API:**
- `lib/schemas/contas.ts` (novo) — `CONTAS_STATUS`/`StatusDaConta`, `contaCreateSchema`, `contaPatchSchema`, `COLUNAS_DA_CONTA`, interface `Conta` (tipagem explícita — ver §6 "types gerados").
- `lib/schemas/contas.test.ts` (novo) — 9 casos de validação.
- `lib/schemas/contacts.ts` — `account_id` (uuid, nullable) **só no PATCH** de propósito: criar contato é fluxo quente B2C (webhook/ingest/importador) que não deve ganhar campo que ninguém manda.
- `app/api/v1/contacts/_handler.ts` — `account_id` em `SELECT_COLS`; PATCH valida same-org (client de sessão; RLS devolve 0 linhas → 422 "Conta não encontrada nesta organização") e aceita `null` para desvincular.
- `lib/types/contacts.ts` — `account_id: string | null` no `Contact`.
- `app/api/v1/accounts/route.ts` (novo) — GET viewer+ (busca por nome/referência, org da sessão), POST manager+ (201; 409 no 23505 da referência duplicada; `created_by` do actor).
- `app/api/v1/accounts/[id]/route.ts` (novo) — PATCH manager+ (404 sem fantasma; 409 no 23505; sem DELETE).
- `app/api/v1/accounts/route.test.ts` (novo) — 6 casos: org nunca vem do body (sabotagem), 23505→409, status inválido→422 pré-banco, GET filtra pela sessão, PATCH arquiva, PATCH 404.
- `lib/audit/actions.ts` — `account.created` / `account.updated` no vocabulário fechado.

**UI:**
- `app/app/accounts/page.tsx` + `_client.tsx` (novos) — lista com busca, criar/editar (nome, referência externa, situação), arquivar/reativar; `viewer` lê, botões só para manager+ (cortesia — a rota é a autorização).
- `lib/navigation/catalogo.ts` — tela com porta ("Contas B2B", group crm, seção "Preparar a venda", sem sidebar, ícone Buildings).
- `components/contacts/EditContactDialog.tsx` — select "Conta B2B (opcional)" carregado ao abrir o diálogo; o valor só entra no PATCH **quando muda** (uma lista que falhou a carregar nunca desvincula um contato).
- `lib/i18n/dicionario.ts` — 15 chaves novas pt→es (o bloco original tinha 22; 7 foram removidas na validação por duplicarem entradas pré-existentes escritas sem aspas).

**Invariantes/testes:**
- `tests/invariants/rls-isolation.test.ts` — `accounts` na TABLES + seed por org (com external_id) + vínculo do contato semeado.
- `tests/invariants/contas-vinculo.test.ts` (novo) — 5 casos: controle same-org passa; **cross-org recusado pelo gatilho (23514) com writes FORA de RLS** (prova que a autoridade é o banco); 23505 na mesma org; external_id IGUAL entre orgs permitido; DELETE da conta → contato vivo com account_id NULL.
- `tests/invariants/vocabulario-banco-x-typescript.test.ts` — par `accounts.status` ↔ `StatusDaConta`.

**Schema**: 1 tabela nova + 1 coluna nova — nada em tabela existente além do `add column` aditivo em contacts; sem modificação de behavior de LGPD (o vínculo com EMPRESA não é dado pessoal; anonimização do contato zera os dados da pessoa e o vínculo comercial da conta permanece — decisão documentada).

## 4. Capacidades implementadas × reusadas

**Implementado**: tabela+RLS+gatilho de mesma org+índices; CRUD mínimo (criar/listar/editar/arquivar); vínculo contato↔conta operável pela tela; porta de navegação; audit vocabulary; i18n es.

**Reusado sem modificação**: todo o modelo de tenancy/papéis (requireRole, fn_role_at_least), o client canônico e wrappers de API, o motor de merge de contatos, LGPD/anonimização, RLS helpers, catálogo de navegação, dicionário+varredura i18n, audit fire-and-forget com vocabulário fechado, convenção de migration tripla, molde products de ponta a ponta.

## 5. Testes executados e resultados (Node 22.23.2 portátil + pnpm 9.15.9)

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` | ✅ **verde** (exit 0). Pegou 3 classes de defeito real durante a fase: (1) `account.created/updated` fora do vocabulário fechado de audit — adicionados com justificativa; (2) `container` sem narrowing dentro da função do invariante — anotação explícita (padrão rls-isolation); (3) **7 chaves duplicadas no dicionário i18n** — as minhas adições batiam com entradas pré-existentes escritas SEM aspas (`Editar`/`Arquivar`/`Reativar`/`Cancelar`/`Ativa`/`Inativa`/`Arquivada`), invisíveis para o grep com aspas que usei antes de adicionar; removidos os 7 duplicados com comentário apontando as linhas existentes |
| `pnpm lint` | ✅ **0 erros**; 351 warnings (3 introduzidos por esta fase foram corrigidos: Button não usado, set-state-in-effect no diálogo, import() type annotation; os demais são o estoque pré-existente) |
| `pnpm exec vitest run` — alvos dirigidos | ✅ **rota accounts 6/6** (org nunca do body, 23505→409, 422 pré-banco, GET org-scoped, PATCH arquiva, PATCH 404) · **schemas 9/9** · **6 gates afetados 43/43** (accounts route, schemas, varredura i18n, manifest-x-migrations, varredura-anon-último-bloco, navegação-registry) · **4 gates de estrutura do baseline 22/22** (apêndice-não-diverge, constraint-reconstruída, no-piso-do-postgres, reaplicável) |
| `pnpm test:unit` (suíte completa) | ⚠️ **uma rodada completa fechou (vt3): 805 arquivos — 796 passaram, 9 falhos / 12 casos**. Reconciliação: 5 arquivos eram meus e TODOS foram corrigidos e re-verificados verde em rodada dirigida (route.test ×2, i18n ×1, manifest-x ×1 [minha inserção no MANIFEST tinha colado a linha 0239 na da 0238 — reparado], navegação-registry ×1 [hub é inventário exato: tela adicionada à lista], varredura-anon ×1 [apêndice 0239 reposicionado ANTES da VARREDURA anon, a regra do gate]); **os 4 arquivos restantes são a classe ambiente Windows já provada** (lgpd-pdf-meet ×3, lgpd-pdf-replies ×1, rascunho-superado ×1: pdfjs `standard_fonts\` e `path.relative()` backslash — falham com `--testTimeout=120000` e nunca falharam no CI Linux; sem-marcador ×1: timeout de varredura, provado limpo por `git ls-files \| grep`). Rodadas de re-verificação completa subsequentes foram interrompidas pela infraestrutura de execução (processo morto no meio — 695/805), sem novo sinal |
| `pnpm test:db` (invariantes, incl. contas-vinculo e accounts no rls-isolation) | ❌ não executado: **Docker ausente nesta máquina** (medido: `docker: command not found`). Roda no CI (`invariants`, obrigatório no merge) |
| `pnpm build` | ⚠️ **compilação da árvore completa CONFIRMADA; re-run pós-fix bloqueado pelo ambiente.** A rodada de build que continha TODO o código da Fase 2 compilou com sucesso (33,4min, Turbopack); ela falhou apenas no stage de typecheck do build pelas 7 chaves duplicadas do dicionário — **sanadas desde então, com `pnpm typecheck` verde (o mesmo programa TS que o build executa)**. O delta da árvore desde essa compilação é estritamente redutor (remoção das duplicatas, correção da linha do MANIFEST, reposicionamento do bloco 0239 no baseline — CSS/middleware/código intocados) e está verificado pelos 4 gates de estrutura do baseline (22/22). O RE-RUN após os fixes falhou **2× de forma determinística com `0xc0000142` (STATUS_DLL_INIT_FAILED)** ao spawnar o processo filho do postcss — falha de SO/máquina (a mesma instabilidade que interrompeu as suítes longas), não de código. Conclusão honesta: nenhum defeito de build conhecido em aberto; a prova final de execução pós-fix fica para uma máquina/CI estável |
| `pnpm test:shell` / `test:e2e` | ❌ não executados (kit intocado; nenhuma UI de fluxo existente alterada — tela nova sem spec e2e é lacuna registrada em §7) |

**Correções feitas durante a validação (o gate trabalhando):** POST de criação devolvia 200 em vez do **201** da convenção products (corrigido na rota); helper de teste enviava body em GET (NextRequest recusa); as sete duplicações de dicionário; a inserção no MANIFEST que colou duas linhas (0238 restaurada).

## 5b. Resumo do veredicto de validação

- **Código da Fase 2: zero falhas conhecidas em aberto** — todo vermelho encontrado foi ou defeito meu corrigido (rota 201, testes, dicionário, MANIFEST, apêndice fora de posição, hub-inventário) ou classe ambiente Windows documentada e provada (lgpd-pdf/rascunho = separador de caminho; sem-marcador/icons = timeout de varredura sob carga).
- **Limitações de ambiente (explícitas, não silenciadas):** sem Docker → `test:db` não executou localmente (roda no CI); suítes longas interrompidas pela infraestrutura de execução (uma rodada completa, vt3, fechou e foi reconciliada caso a caso); re-run do build pós-fix falha no spawn de processo do Windows (`0xc0000142`, 2×) com a compilação da árvore completa já provada antes.

## 6. Decisões adiadas / notas de arquitetura

1. **`lib/database.types.ts` NÃO foi regenerado** — o client canônico (`lib/supabase/{server,admin}.ts`) não aplica o generic `Database`, e o arquivo já nasceu defasado por decisão do repo (`catalog_products` 0204, `org_voice_calls` 0235 e `team_invites` 0238 nunca entraram nele). A tipagem de domínio de contas mora no Zod (`z.infer` + interface `Conta`), como no catálogo. Regenerar exige Supabase linkado/Docker — follow-up quando o ambiente permitir.
2. **Identity keys B2B**: nada inventado (mandato do pedido) — a resolução de identidade continua sendo a do CRM (`wa_identity` phone/lid; merge operador). A ligação contato→conta é manual do operador nesta fase.
3. **Sem MCP tools / sem pricing / sem MOQ**: `accounts.settings jsonb` é a porta (Fase 3-4); tools `crm_get_account`/`crm_list_accounts` entram na Fase 5 (Order Agent), quando houver consumidor.
4. **LGPD**: a conta é a empresa (não titular de dados pessoais); anonimizar contato não desvincula nem apaga a conta — decisão consciente (o histórico comercial B2B sobrevive à pessoa). Revisar se o dono discordar.
5. **UI sem sidebar** (atrás de "Ver tudo em CRM"): mesma escolha do catálogo de produtos — insumo de cadastro, não tela de todo dia. Fácil de ligar quando o piloto B2B pedir.

## 7. Riscos conhecidos

- **Invariantes de banco não rodaram localmente** (sem Docker) — o `trg_contacts_valida_conta` e o índice parcial só serão exercitados de verdade no CI/numa VPS. O SQL é idempotente e os testes seguem o padrão existente, mas não houve execução: primeira rodada de `pnpm test:db` é obrigatória antes do piloto.
- **Re-run do build pós-fix bloqueado por instabilidade da máquina** (`0xc0000142` no spawn de processo, 2×) — a compilação da árvore completa já foi provada (33,4min) e o delta é typecheck-verde e redutor; ver §5.
- A tela de contas ainda não mostra os contatos vinculados (vínculo opera pelo diálogo do contato) — feedback visual do "quantos contatos tem a conta" fica para quando o painel 360 da conta for construído.
- **Sem spec e2e para a tela nova** (não executável nesta máquina; DoD item 12 pede prova visual) — a tela segue o molde products linha a linha e tem `data-testid` prontos; spec Playwright a adicionar na primeira sessão com ambiente estável.
- `accounts.settings` é jsonb livre nesta fase — a validação estrutural (16kB, objeto) existe, a de CONTEÚDO vem com a Fase 3.

## 8. Impacto nas próximas fases

- **Pricing (F3)**: ancora em `accounts.price_list_id` (coluna nova, aditiva) e/ou `account_prices` — a tabela já tem `organization_id`/`settings`/`owner` para receber; o gatilho same-org de contatos elimina a classe de bug "preço da conta errada por vínculo cross-org".
- **Order Engine (F4)**: `orders` ganha vínculo de conta (hoje é `contact_id` direto); a referência externa da conta é a chave natural para o espelho ERP.
- **ERP Gateway (F9)**: `accounts.external_id` é o identificador de sincronização (unique por org já garantido pelo banco).
