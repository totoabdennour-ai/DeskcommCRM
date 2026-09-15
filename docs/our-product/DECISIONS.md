---
type: our-product/phase-0-audit
doc: DECISIONS
status: proposto — aguardando revisão do dono (Fase 0 não decide sozinha)
created: 2026-09-14
audited_at_commit: 5c132f4d
---

# DECISIONS.md — Decisões de arquitetura da Fase 0

Status de cada decisão: **PROPOSTO** (esta auditoria recomenda; o dono revisa) ou **CONFIRMADO**
(preso por código/doutrina existente do repo — a auditoria apenas documenta). Nenhuma decisão
PROPOSTA foi implementada.

| # | Decisão | Status | Justificativa (evidência) | Alternativas consideradas |
|---|---|---|---|---|
| D1 | **DeskcommCRM é a fundação; a transformação B2B é aditiva** (sem reescrita) | PROPOSTO | 18/30 subsistemas KEEP (doc 12); schema antecipou comércio e parou um passo antes do escritor de pedidos (doc 06: `orders` sem writer, `crm_lead_links('order')` sem producer, `catalog_products` vivo) | Reescrever sobre ERPNext — recusado (doutrina do dono + perda de RLS/guardrails/self-host) |
| D2 | **Monólito modular** — módulos novos (`lib/orders`, `lib/pricing`, `lib/accounts`, `lib/erp`, `lib/receita`) no mesmo processo + worker existente | PROPOSTO | Gargalo observado é domínio ausente, não escala (docs 07/15); zero serviços novos no compose | Microserviços — sem evidência; recusado |
| D3 | **Reusar a tabela `orders`** com mudança de contrato (`origin` + CHECK ampliado) em vez de tabela nova `sales_orders` | PROPOSTO | 4 leitores vivos já apontam para ela (inbox crm-summary, MCP `crm_list_contact_orders`, LGPD export preserva totais, admin stats — doc 06 §1); economiza pontes e migration de leitores | Tabela nova — mais limpa conceitualmente, custo maior; pode ser revisada pelo dono (OPEN QUESTION 2 do doc 17) |
| D4 | **Preço resolvido determinístico (SQL), nunca pelo LLM**; LLM só lê o resultado | PROPOSTO | Erro de preço = dano financeiro; correção > flexibilidade (doc 04 §7, doc 18 §2) | Cálculo pelo agente — recusado |
| D5 | **Confirmação explícita do cliente** antes de pedido confirmar; rascunho→confirmação como invariante de domínio | PROPOSTO | Confiança no pedido conversacional; precedente de gate before-send (promise-table, doc 04 §4) | Confirmação automática por regra — possível knob por org depois |
| D6 | **Fluxos de dinheiro usam `job_queue` + outbox no mesmo commit; jamais o drain genérico** | PROPOSTO (baseado em código) | Drain genérico: CAS sem SKIP LOCKED, dead silencioso, sem dedup key (doc 07 §2/§6); job_queue tem exactly-once de efeito (`completeJob(inSameCommit)`) | — |
| D7 | **n8n fora do core** (opcional ao operador via webhooks de saída) | PROPOSTO | Duplicaria barramento sem primitivos de dedup/ledger/RLS; fora dos invariantes de CI (docs 10-11); n8n ausente do repo (doc 01 §9) | n8n como orquestrador — recusado |
| D8 | **ERPNext via adapter único (8 operações), clean-room (GPL), credencial por org cifrada**; estoque/preço consultados on-demand com cache curto, não espelhados | PROPOSTO | Doc 10 completo; pacifica dependência externa e licença | Espelho contínuo de estoque — fase tardia se demanda |
| D9 | **Gate automático de `organization_id` em handlers service-role antes da Fase 4** (varredura no estilo `cron-audita-so-quando-ha-efeito`) | PROPOSTO | R1 HIGH: 149/270 rotas com `createAdminClient`, nenhum gate (doc 08/09); custo baixo | Só revisão humana — recusado para domínio de dinheiro |
| D10 | **Fase 1 = estabilização de fundação** (dead-letter alerta, fire-and-forget, dev-fallback, rate limit de borda, CSP/HSTS, gitleaks, CPF) antes de qualquer domínio | PROPOSTO | Dívidas baratas que todo fluxo de dinheiro herda (docs 08/16) | Começar pelo domínio — recusado |
| D11 | **Buscar SKU com o algoritmo token-wise existente; não introduzir busca vetorial para catálogo** | CONFIRMADO (código) + PROPOSTO de manter | `lib/catalogo/busca.ts` construído e calibrado contra corpus real de 20k títulos onde `ilike`/vetorial falharam (doc 06 §1) | Embeddings de produto — desnecessário no MVP |
| D12 | **Variantes de produto permanecem flat (1 linha por SKU)** | CONFIRMADO (decisão 0204) | Header da migration 0204 é explícito; invariantes travam a filosofia | Matriz de variantes — recusada pelo repo |
| D13 | **Tool MCP nova segue contrato de nomes congelados** (`crm_create_order`, `crm_quote_price` são NOMES NOVOS; nunca renomear publicadas) | CONFIRMADO (doutrina do repo) | `lib/mcp/tools/catalogo/comercio.ts` header: "Nunca renomeie tool publicada" | — |
| D14 | **VPS-first**: o produto-alvo assume worker + scheduler (Vercel é vitrine; liveness do barramento depende dos containers) | PROPOSTO | `vercel.ts` agenda 1 cron só (doc 02 §5); order engine precisa de fila | Portar crons para Vercel — desnecessário para o alvo |
| D15 | **LGPD estende cascata para accounts/orders** (redact preserva totais como hoje) | PROPOSTO | Preservação de totais já é comportamento do redact (doc 06) | — |
| D16 | **Idioma e práticas do repo mantidos** (PT-BR, tripla de migration, DoD 17 itens, QA visual como aceite) | CONFIRMADO (doutrina) | AGENTS/CLAUDE.md; toda fase do doc 16 entrega com DoD | — |
| D17 | **CPF = hash PSEUDÔNIMO (sha256 sem salt), sem criptografia reversível.** O caminho `encryptCpfSql`/RPC `encrypt_cpf` foi extirpado; `CPF_ENCRYPTION_KEY` saiu do contrato de env; a coluna `contacts.cpf_encrypted` permanece reservada e vazia (sem migration — apagar coluna de PII em cascade LGPD é risco sem ganho). Aprovado pelo dono no review da Fase 0 | CONFIRMADO (decisão do dono, implementada na Fase 1) | `lib/contacts/cpf.ts` (modelo documentado), `lib/lgpd/export-collector.ts` (`cpf_present` agora lê `cpf_hash`), testes em `lib/contacts/cpf.test.ts` | Criptografia reversível — recusada nesta fase; se um dia exigida legalmente, decisão de produto nova com migration/chave/invariante próprios |

## Registro de decisões adiadas (não decidir na Fase 0)

- Estrutura fiscal (NF-e/impostos) — fora do MVP; o ERP é o sistema fiscal (D8).
- Multi-CD/armazéns — só com evidência de piloto.
- Instagram/Messenger — demanda real do piloto decide (doc 17 Q10).
- Consolidação multi-moeda de relatórios — doc 17 Q3.
