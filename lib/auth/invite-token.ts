/**
 * Stateless HMAC-SHA256 invite token. Self-contained payload, signed and
 * base64url-encoded — no DB row required to issue. Verified at accept time.
 *
 * Format: `<body>.<sig>` where
 *   - body = base64url(JSON({invite_id, email, organization_id, role, exp}))
 *   - sig  = base64url(HMAC_SHA256(secret, body))
 *
 * Secret resolution: INVITE_TOKEN_SECRET → INTERNAL_SECRET. Production
 * deployments MUST set one of the two (`INTERNAL_SECRET` is `required()` in
 * `lib/env.ts` — the boot fails closed without it).
 *
 * Fase 1 (docs/our-product/DECISIONS.md, D17): the literal `"dev-fallback"` is
 * GONE. It was repo-public knowledge — anyone with the open-source repo could
 * forge a valid invite (payload includes `organization_id` + `role`, i.e.
 * admin in any org). When neither secret is configured (dev only), the module
 * mints a RANDOM per-process secret with a loud warning: signatures verify
 * within the same process (the only dev topology), survive nothing across
 * restarts, and are NOT forgeable from repository knowledge. Empty-string env
 * values are treated as absent (a present-empty key must NOT become the HMAC
 * key). Verification still uses `timingSafeEqual`.
 */
import { z } from "zod";
import { interfaceSettingsSchema, type InterfaceSettings } from "@/lib/navigation/interface";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "@/lib/logger";

let devSecretPorProcesso: string | null = null;
let avisoJaDado = false;

const SECRET = (): string => {
  // Vazio NÃO é segredo: o `.env.example` entrega as chaves PRESENTES E VAZIAS
  // (doutrina do teste env-vazia-no-exemplo), e "" passado ao createHmac seria
  // uma assinatura com chave nula. Para um SECRET, vazio = ausente — pular
  // vazios aqui é a política correta, e é o que faz o third-state
  // (presente-vazio) cair corretamente para INTERNAL_SECRET.
  const declarado = [process.env.INVITE_TOKEN_SECRET, process.env.INTERNAL_SECRET].find(
    (s) => typeof s === "string" && s.length > 0,
  );
  if (declarado) return declarado;

  // Dev sem secret nenhum: segredo ALEATÓRIO deste processo, nunca uma
  // constante pública. Assina e verifica dentro do mesmo processo (a única
  // topologia em que o fallback é alcançável — em produção o boot já falhou
  // sem INTERNAL_SECRET).
  if (!devSecretPorProcesso) {
    devSecretPorProcesso = randomBytes(32).toString("hex");
  }
  if (!avisoJaDado) {
    avisoJaDado = true;
    logger.warn(
      "[invite-token] nenhum secret configurado (INVITE_TOKEN_SECRET|INTERNAL_SECRET) — " +
        "usando segredo aleatório EFÊMERO deste processo: tokens de convite não " +
        "sobrevivem a restart. Configure INVITE_TOKEN_SECRET para persistência.",
    );
  }
  return devSecretPorProcesso;
};

export interface InvitePayload {
  interface_settings?: InterfaceSettings;
  invite_id: string;
  email: string;
  organization_id: string;
  role: string;
  exp: number; // epoch seconds
  iat?: number;
  invited_by?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signInviteToken(payload: InvitePayload): string {
  const json = JSON.stringify(payload);
  const body = b64url(Buffer.from(json, "utf8"));
  const sig = b64url(createHmac("sha256", SECRET()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyInviteToken(token: string): InvitePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = b64url(createHmac("sha256", SECRET()).update(body).digest());
  if (sig.length !== expected.length) return null;

  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  let payload: InvitePayload;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    payload = JSON.parse(json) as InvitePayload;
  } catch {
    return null;
  }

  const checked = z
    .object({
      invite_id: z.string().uuid(),
      email: z.string().email(),
      organization_id: z.string().uuid(),
      role: z.enum(["viewer", "agent", "manager", "admin"]),
      exp: z.number().int().positive(),
      iat: z.number().int().positive().optional(),
      invited_by: z.string().uuid().optional(),
      interface_settings: interfaceSettingsSchema.optional(),
    })
    .safeParse(payload);
  if (!checked.success) return null;
  payload = checked.data;

  if (payload.exp * 1000 < Date.now()) return null;
  return payload;
}

export const INVITE_TTL_SECONDS = 60 * 60 * 24; // 24h
