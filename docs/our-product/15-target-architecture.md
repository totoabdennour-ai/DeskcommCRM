---
type: our-product/phase-0-audit
doc: 15-target-architecture
status: final
created: 2026-09-14
type_note: RECOMENDAÇÃO — monólito modular; nenhum microserviço especulativo
---

# 15 — Arquitetura alvo

## 1. Decisão-quadro (RECOMENDAÇÃO)

**Manter o monólito modular Next.js + worker 24/7 + Postgres como barramento.** A auditoria mostra que a plataforma atual já implementa os difíceis (outbox transacional, fila durável com SKIP LOCKED, idempotência, RLS com varredura, guardrails) e que o domínio novo (pedido/pricing/ERP) cabe em **módulos novos dentro do mesmo processo**. Microserviços não têm justificativa de evidência nesta fase: o gargalo observado é domínio ausente, não escala.

## 2. Módulos alvo (novos) e onde moram

| Módulo | Local proposto | Responsabilidade | Não-responsabilidade |
|---|---|---|---|
| **Order Engine** | `lib/orders/` (engine) + `app/api/v1/orders/` + drainer dedicado em `lib/orders/drain.ts` | criação (idempotente), lifecycle, emendas, invariantes 1-8 do doc 14 | preço (delega), ERP (delega) |
| **Pricing** | `lib/pricing/` | resolução override>lista>catálogo; validação MOQ/desconto | cobrança |
| **Catalog Intelligence** | extensão de `lib/catalogo/` | unidade, sinônimos, resolução SKU por linguagem natural | estoque de verdade (ERP) |
| **ERP Gateway** | `lib/erp/` + `lib/erp/adapters/erpnext.ts` | interface de 8 operações (doc 10), sync_ledger, reconciliação | lógica de pedido |
| **Revenue Recovery** | `lib/receita/` (detector) + reuso do motor de follow-up | oportunidades monetárias, eventos de recuperação | envio (reusa canais) |
| **Account** | `lib/accounts/` + telas | contas B2B, condições, rep | pricing (delega) |

Regras de fronteira (herdadas da doutrina do repo): regra de negócio NUNCA no adapter (mesma doutrina de `restricao-de-canal`); trigger nunca faz HTTP; tudo que é dinheiro usa `job_queue` + outbox no mesmo commit; toda tela nova tem porta no `lib/navigation/registry.ts`; toda tabela nova nasce no triple (migration + baseline + MANIFEST) e na varredura RLS.

## 3. Avaliação da stack atual para o alvo (componente a componente)

| Componente | Avaliação | Decisão |
|---|---|---|
| Next.js 16 + React 19 (App Router) | Adequado; UI já tem produto, kanban, inbox | **KEEP** |
| TypeScript estrito | Adequado; contratos de tool congelados por nome | **KEEP** |
| Postgres/Supabase (RLS, Realtime, Storage) | Adequado; RLS com varredura é diferencial; pgvector serve para RAG de catálogo | **KEEP** (sem pgvector novo para busca de SKU — a busca token-wise já provada é melhor para SKU) |
| Redis + SRH (efêmero) | Correto como otimização; nunca no caminho de dinheiro | **KEEP** |
| Workers (job_queue + crons) | O único executor confiável para pedidos; vercel não agenda | **KEEP** (produto é VPS-first) |
| AI SDK v7 + runModelCall | Seam único com budget por org; falta 2º generateObject para extração de pedido | **KEEP + EXTEND** |
| MCP | Servidor pronto para tools de pedido; sem cliente interno necessário | **KEEP** |
| Object Storage (Supabase) | Suficiente (mídia, exports); PDF de pedido entra como mídia derivada | **KEEP** |
| WAHA/Meta/Zernio | Canal primário resolvido; multicanal real é fase tardia | **KEEP** |
| ERP adapters | A construir (doc 10) | **BUILD** |
| n8n | **FORA DO CORE** — justificativa: duplicaria barramento sem os primitivos de dedup/ledger/RLS; webhooks de saída já cobrem automação externa do operador | **NÃO INTEGRAR** (opcional ao operador) |

## 4. Topologia de deploy (inalterada)

VPS: `app` + `worker` + `scheduler` + `waha` + `redis`/`srh` + `caddy` (+ `wacalls` opt-in). Imagens do CI, baseline auto-curativo, update pela tela. O ERP do cliente é chamado **de dentro** do worker/app (egress), e pode chamar **webhooks nossos** (nova superfície HMAC por conexão ERP — seguir padrão `webhooks/[token]`).

## 5. O que prioriza o desenho (do pedido do dono)

Simplicidade (monólito) · correção (outbox + invariantes de pedido) · segurança (RLS-primero, gate de service-role antes da Fase 4) · testabilidade (invariantes de banco por invariante de domínio) · manutenibilidade (módulos novos fora do inbound-turn god-file) · custo operacional (zero serviço novo; ERP polling com cache curto) · desenvolvimento rápido (reuso de 18 subsistemas KEEP) · escalabilidade futura (módulos com fronteira limpa podem extrair depois, se e quando a evidência pedir).
