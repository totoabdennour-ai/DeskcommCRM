/**
 * Rate limit de BORDA (middleware `proxy.ts`) — Fase 1, risco R4 do doc 08.
 *
 * ─── O buraco que este módulo fecha ──────────────────────────────────────────
 *
 * Os guards de secret da superfície não-cookie são fortes (HMAC timing-safe,
 * Bearer hash, fail-closed), mas nada limitava TENTATIVAS na frente deles:
 * `/api/v1/cron/*` (22 rotas), `/api/internal/*`, `/api/mcp` (enumeração de
 * bearer), `/api/v1/system/*` e `/auth/confirm` aceitavam brute-force na
 * velocidade da rede, sem sinal de alerta. O rate limit que existia era por
 * rota (login, captação…), não por prefixo — cada superfície nova nascia sem.
 *
 * ─── Decisões de desenho (com a razão de cada uma) ───────────────────────────
 *
 * 1. **Por prefixo, e por IP.** Uma regra por prefixo cobre toda a família de
 *    uma vez — rota nova sob `/api/v1/cron/` nasce limitada sem ninguém
 *    lembrar. O contador reusa `checkRateLimit` (janela fixa INCR+EXPIRE,
 *    fallback em memória) — nenhuma infra nova.
 * 2. **Webhooks ficam FORA de propósito.** WAHA/Meta/Nuvemshop têm guard
 *    próprio por sessão e bursts legítimos de provedor; um teto de borda
 *    compartilhado por IP pode derrubar ingestão real. O `in/[token]` já tem
 *    o seu (60/min por token).
 * 3. **Sem IP identificável, NÃO limita.** Mesma doutrina de
 *    `lib/auth/rate-limit.ts`: um balde global único (`opaque("sem-ip")`)
 *    converte o limite em DoS de custo zero contra a própria instalação.
 * 4. **Falha ABERTA em erro inesperado.** O middleware atende TODA requisição:
 *    se uma exceção do limitador derrubasse a borda, trocaríamos risco de
 *    brute-force por indisponibilidade total. O caminho normal de falha
 *    (Redis inalcançável) já é coberto pelo fallback em memória do
 *    `checkRateLimit`; o `catch` daqui é para o que sobrou.
 * 5. **Identificador hasheado** (`crypto.subtle`, Edge-compatible) antes de
 *    virar chave de Redis — chave de Redis é lugar de dado opaco.
 */
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

export interface EdgeRateLimitRule {
  /** Prefixo de pathname (startsWith). */
  prefix: string;
  /** Tentativas por janela por IP. */
  limit: number;
  windowSec: number;
}

/**
 * Tetos por superfície. Folgados de propósito: o objetivo é tirar o custo-zero
 * do brute-force, não estorvar operação. O cron chega do `scheduler` por UM IP
 * interno (todas as 22 rotas dividem o balde) — ~10 requisições/min na soma das
 * cadências atuais, logo 120/min é folga de 12×. MCP externo usa agente que
 * faz dezenas de chamadas por sessão — 120/min por IP cobre uso sério e ainda
 * mata enumeração de bearer em escala.
 */
export const EDGE_RATE_LIMITS: EdgeRateLimitRule[] = [
  { prefix: "/api/v1/cron/", limit: 120, windowSec: 60 },
  { prefix: "/api/internal/", limit: 120, windowSec: 60 },
  { prefix: "/api/mcp", limit: 120, windowSec: 60 },
  { prefix: "/api/v1/system/", limit: 120, windowSec: 60 },
  { prefix: "/auth/confirm", limit: 20, windowSec: 60 },
];

/** Regra aplicável ao pathname, ou `null` (fora do escopo da borda). */
export function regraDeBorda(pathname: string): EdgeRateLimitRule | null {
  return EDGE_RATE_LIMITS.find((r) => pathname === r.prefix || pathname.startsWith(r.prefix)) ?? null;
}

/** IP do cliente pelos headers de proxy; `null` quando não dá para saber. */
export function ipDaBorda(request: { headers: Headers }): string | null {
  const encaminhado = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (encaminhado) return encaminhado;
  return request.headers.get("x-real-ip")?.trim() || null;
}

async function hashOpaco(valor: string): Promise<string> {
  const bytes = new TextEncoder().encode(valor.trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

let avisoJaDado = false;

/**
 * `true` = barra a requisição (estourou o teto). Sem IP ou sem regra: `false`.
 */
export async function edgeRateLimited(pathname: string, ip: string | null): Promise<boolean> {
  const regra = regraDeBorda(pathname);
  if (!regra || ip === null) return false;

  try {
    const resultado = await checkRateLimit(
      `edge:${regra.prefix}:ip:${await hashOpaco(ip)}`,
      regra.limit,
      regra.windowSec,
    );
    return !resultado.allowed;
  } catch (err) {
    // Falha aberta (decisão 4): borda viva > limite perfeito. O fallback em
    // memória do checkRateLimit já cobriu o caso "Redis caiu"; isto aqui é
    // para exceção inesperada fora do caminho de rede.
    if (!avisoJaDado) {
      avisoJaDado = true;
      logger.warn("[rate-limit-edge] limitador falhou — requisição liberada (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
        prefix: regra.prefix,
      });
    }
    return false;
  }
}
