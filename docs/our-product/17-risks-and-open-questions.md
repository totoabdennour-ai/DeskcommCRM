---
type: our-product/phase-0-audit
doc: 17-risks-and-open-questions
status: final
created: 2026-09-14
---

# 17 — Riscos e perguntas abertas

## 1. Riscos por categoria (com evidência)

**Arquitetura**
- A1 — **God-file do hot path**: `inbound-turn.ts` 4.083 l.; agentes novos não devem crescer ali (módulos próprios; doc 15). Prob. alta, impacto médio.
- A2 — **Drain genérico um nível abaixo do job_queue**: usado como atalho, um fluxo de dinheiro nele herda dead-letter silencioso e sem SKIP LOCKED (doc 07). Mitigado por regra de desenho.
- A3 — **Dois caminhos de IA** (legado dispatcher + engine) até o REMOVE (doc 12). Médio.
- A4 — **Contrato de `orders` muda** (espelho→nativo): 4 leitores vivos; migration precisa dedup/compat (doc 03/06). Alto impacto, controle alto (tripla doutrina).

**Segurança**
- S1 — Service-role sem gate de escrita (R1, HIGH) — fechado na Fase 1.
- S2 — CPF hash sem salt / controle declarado sem provisionamento (R2, HIGH LGPD).
- S3 — Sem CSP/HSTS; sem rate limit em superfícies de secret (R4/R5, MEDIUM).

**Dados**
- D1 — Pedidos históricos só existem no payload jsonb da Nuvemshop (não sincronizados); migração de dados de ERP de piloto é projeto por cliente.
- D2 — Moeda: orders mantêm moeda de nascimento; relatórios multi-moeda precisam de política de conversão (OPEN QUESTION: relatar em BRL apenas?).

**IA**
- I1 — Preço errado em pedido = dano financeiro; mitigação: resolução determinística (não-LLM) de preço + confirmação explícita + promise-table por conta.
- I2 — Custo: extração estruturada nova soma tokens; budget por org já existe, custo NULL para modelos não-Claude é ponto cego contábil (doc 04).
- I3 — Dependência de chave OpenAI para embeddings/Whisper (ladder de chave já trata, mas operador precisa saber).

**Integração**
- E1 — ERP do piloto pode não ter API estável; sync_ledger + estados visíveis são o design de falha (doc 10).
- E2 — WAHA Core não assina webhooks por default (honestidade registrada); exigir Plus/assinatura em instalações B2B sensíveis.

**Multi-tenancy**
- M1 — Cada rota/tool nova de pedido é oportunidade de vazamento cross-tenant (mitigado pelo gate da Fase 1).

**Escalabilidade**
- X1 — order_events/llm_calls crescem sem partição; retenção existe para outras tabelas — estender (Fase 10).

**Produto**
- P1 — Posicionar B2B sem matar multi-nicho (doc 13 §4).
- P2 — Vercel vs VPS: liveness do barramento depende de worker+scheduler (VPS-first é a recomendação; decisão final do dono).

**Licença**
- L1 — WAHA Plus é licenciado e não-republicável (doutrina de packaging já cobre; tag fixa). ERPNext é GPL — adapter REST não deriva obra, mas **sem copiar código** para o adapter; manter adapter clean-room.

## 2. Perguntas abertas para o dono (decidem desenho, não implementação)

1. **n8n**: os workflows protótipo podem ser exportados (JSON) para consulta? (doc 11 — 5 OPEN QUESTIONS de regra de negócio dependem disso.)
2. **`orders` reusado vs tabela nova**: a recomendação é reusar com `origin` (doc 06/14). Confirma?
3. **Moeda de relatório**: consolidar em BRL com taxa do dia, ou relatório por moeda?
4. **Crédito**: limite é bloqueio duro (não confirma pedido) ou alerta?
5. **Vercel**: manter como vitrine (só 1 cron) ou descontinuar o modo?
6. **Multi-nicho**: o modo B2B entra como vertical (template de onboarding) — posicionar publicamente agora ou depois do piloto?
7. **Estoque**: consultado on-demand no ERP (recomendado) ou espelhado com sincronia?
8. **Piloto**: existe já um distribuidor parceiro com ERPNext definido? (muda prioridade F9 vs F6.)
9. **CPF/R2**: provisionar criptografia reversível (exigência legal?) ou hash pseudônimo documentado?
10. **Instagram/Messenger**: real para o piloto B2B ou backlog?
