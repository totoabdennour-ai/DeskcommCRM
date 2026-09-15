---
type: our-product/phase-0-audit
doc: 05-channel-audit
status: final
created: 2026-09-14
audited_at_commit: 5c132f4d
evidence: lib/waha/, lib/channels/, lib/messaging/media/, workers/media-*
---

# 05 — Auditoria de canais / WhatsApp

## 1. Fluxo inbound (CONFIRMADO)

WAHA (`webhooks/waha/[token]` per-session ou rota global bloqueada no Caddy) → HMAC **SHA-512** por sessão (`timingSafeEqual`, fail-closed; WAHA Core não assina por padrão — `signatureVerified:false` registrado com honestidade) → raw body arquivado em `webhook_events_log` **antes** do contrato → normalização (`parseChatId` phone/lid/group, tipos, MIME) → **RPCs atômicos de identidade** (`fn_upsert_wa_contact` com `wa_identity` gerado phone/lid; `fn_upsert_wa_conversation`; `fn_mark_conversation_message`) → dedup por unique DEFERRABLE (org, external_id) com captura 23505 → trigger emite `message.received` **uma única vez** → `pos-entrada` (opt-out → nascimento de lead → elegibilidade IA) → `ai_agent.dispatch_requested`.

- `fromMe=true`: operador digitou no aparelho → `direction=outbound, sent_via='external_device'`; eco do próprio envio removido por prova forte (conversa+corpo+60s); não-eco → **silencia IA por janela deslizante** (`pausarIaPorAtendimentoManual`).
- Grupos `@g.us`: sem binding CRM (sender é author).
- Meta Cloud API: webhook próprio SHA-256, ingest reusa os MESMOS RPCs + `aplicarEfeitosPosEntrada`; idempotência obrigatória (Meta re-delivera).
- Merge de contatos: operador-driven (`fn_mesclar_contatos`, FKs repontadas do catálogo, tombstone `is_merged_into`); conflitos de telefone estacionados em `source_metadata.telefone_em_conflito` (merge_queue segue sem escritor automático).

## 2. Fluxo outbound (CONFIRMADO)

**Saída única** (`app/api/v1/messages/_handler.ts`, 951 l.): UI, automação, MCP e agente passam pelo mesmo handler — status `queued` → gate ladder (sessão arquivada/configurada/WORKING/chatId) → template (meta_templates com contract_hash) ou mídia (storage-first, URL assinada 600s, nunca base64) ou texto → adapter → sucesso: eco removido, `sent`+external_id; falha: `failed`+error_code (credencial ausente ≠ falha → re-queue). `message.ack` promove delivered/read. `recover-stuck-messages` (cron 1 min) falha `sending` >5min **sem reenvio** + alerta crítico na Central.

- **Anti-ban**: `decidePacing` (puro, testado) — janela 7-22h no fuso da org (domingo liberável por knob) → caps diários por warm-up (20/50/100/200/∞ em 0/4/8/15/31 dias) → throttle 1.200ms + jitter ≤800ms (`pacing_ledger` é a contagem real; `channel_session_warmup` não tem escritor). `banRisk:false` (meta_cloud/zernio) desarma só o anti-ban, não a janela de cortesia. Constantes guardadas por `scripts/lint-pacing.ts`.
- **Before-send** é onde vivem as regras de negócio (doutrina `restricao-de-canal`, lint `lint-channels`): adapters só traduzem formato.

## 3. Abstração de canais (CONFIRMADO)

- `ChannelProvider = waha | meta_cloud | zernio | wacalls` (voz não-mensagem; guard de compilação `ProviderNaoClassificado`). **Todos são WhatsApp** — meta_cloud/zernio são transporte alternativo do MESMO canal, não canais novos.
- Matriz de capacidades (`lib/channels/capabilities.ts` — único arquivo que conhece diferenças de provider, fail-closed): waha freeform-fora-da-janela/sem template/banRisk/grupos full; meta_cloud/zernio template-only fora da janela (erro 131047 medido), minInterval 6s, opus-only.
- **`conversations.channel` CHECK só 'whatsapp'** (baseline:1392) — coluna vestigial; roteamento é por `channel_session_id`. Adicionar canal novo (Instagram/Messenger) = literal no union + capabilities + adapter + coluna de sessão + CHECK migration + rota **neutra** (`webhooks/channel/[token]` já existe para absorver novos providers sem nova família de URL — padrão zernio pronto).
- Roteamento por canal: `channel_routing_policies/responsibles` (0228) com RPC `fn_channel_routing_claim` serializado (MFA-gated), consumido pelo `routing-worker`.

## 4. Mídia e multimodal (CONFIRMADO)

Persist (`media.persist_requested` → bucket privado `whatsapp-media` em path `{org}/{conversation}/{message}` — 50MB cap) → Derive (`media.derive_requested` → `messages.media_derived_text`, cap 8.000 chars): **áudio** → Whisper (`whisper-1`, requer chave OpenAI própria — a chave de chat não é reutilizada; sem chave → marcador + alerta dedupado na Central); **imagem** → visão do LLM da org (gated por `ai_models.supports_vision`); **PDF/documento** → pdfjs (`lib/ai/rag/extractors/pdf.ts`); **vídeo** → opt-in por agente (ffmpeg + frames). Turno do agente: derivação **gates o dispatch** (espera com teto, depois segue sem texto); anexo nativo (bytes) só para a ÚLTIMA mensagem inbound, só image/pdf, só modelos capazes.

## 5. Sessões, saúde e voz (CONFIRMADO)

- `channel_sessions`: QR 2-fase transacional (`fn_reserve_channel_connection` → WAHA → `fn_finish_channel_connection`), status espelhado por webhook + reconciler admin-plane (resume só STOPPED, nunca FAILED/SCAN_QR por ban-risk), health pull a cada 5 min (só escreve quando alcançável), alertas dedupados por episódio (`qr_rescan`, `channel_number_alert`).
- Voz (wacalls): opt-in duplo (env + `org_voice_calls.enabled`), guarda em toda rota de voz, IA silenciada durante chamada (cap 2h anti-morte), **sem transcrição de chamada**.

## 6. Opt-out e captação (CONFIRMADO)

- `lib/opt-out/deteccao.ts` (fonte única, pt+es): inequívoco (palavra SOLTA ou verbo de cessação + objeto de comunicação, com lookaheads para "parar a dor") → `is_blocked` (desbloqueio só humano); ambíguo → IA silencia + escala. Envio a bloqueado = 403.
- Captação `webhooks/in/[token]`: rate limit 60/min, JSON ou form-urlencoded, mappers Respondi/RD Station/genérico, HMAC opcional, idempotência por external_id (fast-path duplicado 200), consent negado vira atividade e bloqueia IA, drain in-request do `lead.created` (automação dispara sem esperar cron).

## 7. Avaliação para pedido multimodal (o que o produto-alvo pede)

| Modalidade | Existe | Falta para ORDERING | Veredito |
|---|---|---|---|
| Texto | ✅ completo | — | KEEP |
| Voz (nota) | ✅ transcrição Whisper → contexto | transcrição sem semântica de pedido (entidades/qtd); exige chave OpenAI dedicada; chamadas ao vivo sem STT | ADAPT (baixo esforço: schema de extração sobre a transcrição) |
| Imagem | ✅ persist + visão 1-2 frases | sem OCR/extração estruturada; prompt de visão é "atendente", não captura de pedido; 1 imagem só | EXTEND (novo prompt/propósito de visão + extração) |
| PDF/documento | ✅ persist + pdfjs + anexo nativo (1 msg, modelos capazes) | **cap 8.000 chars trunca pedido multi-página silenciosamente**; sem parser de itens | EXTEND (levantar cap com budget, parser de itens) |
| Instagram/Messenger | ❌ | tudo (union, CHECK, adapter, thread-id) | BUILD — caminho preparado (rota neutra + padrão zernio), mudança de schema |

**Riscos/observações**: (1) WAHA Core não assina webhook por padrão — a honestidade do `signatureVerified:false` é correta, mas instalações sensíveis devem ligar `WAHA_WEBHOOK_REQUIRE_SIGNATURE` com WAHA Plus; (2) identidade por LID (WhatsApp novo) já tratada com extração de telefone alternativo; (3) a saída única garante que qualquer política nova de pedido (ex.: bloquear envio de pedido sem confirmação) precisa de UM gate before-send, não de mudanças por surface.
