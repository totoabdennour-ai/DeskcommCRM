import { describe, it, expect, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { signInviteToken, verifyInviteToken, INVITE_TTL_SECONDS } from "./invite-token";

const base = () => ({
  invite_id: "11111111-1111-4111-8111-111111111111",
  email: "alice@example.com",
  organization_id: "22222222-2222-4222-8222-222222222222",
  role: "agent",
  exp: Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS,
});

const SECRETS = ["INVITE_TOKEN_SECRET", "INTERNAL_SECRET"] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("invite-token", () => {
  it("sign+verify roundtrip recovers payload", () => {
    const payload = base();
    const token = signInviteToken(payload);
    const out = verifyInviteToken(token);
    expect(out).toEqual(payload);
  });

  it("returns null for expired token", () => {
    const expired = { ...base(), exp: Math.floor(Date.now() / 1000) - 10 };
    const token = signInviteToken(expired);
    expect(verifyInviteToken(token)).toBeNull();
  });

  it("returns null for tampered signature", () => {
    const token = signInviteToken(base());
    const parts = token.split(".");
    const body = parts[0]!;
    const sig = parts[1]!;
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyInviteToken(`${body}.${flipped}`)).toBeNull();
  });

  it("returns null for tampered body", () => {
    const token = signInviteToken(base());
    const parts = token.split(".");
    const body = parts[0]!;
    const sig = parts[1]!;
    const flipped = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
    expect(verifyInviteToken(`${flipped}.${sig}`)).toBeNull();
  });

  it("returns null for malformed token (no dot)", () => {
    expect(verifyInviteToken("notatoken")).toBeNull();
  });

  it("NÃO verifica token forjado com o antigo literal 'dev-fallback' (Fase 1)", () => {
    // O literal era conhecimento público do repo: quem o conhecesse forjava
    // convite válido (payload carrega organization_id + role). O teste assina
    // manualmente com a chave antiga e exige RECUSA com nenhum secret no env.
    for (const s of SECRETS) vi.stubEnv(s, "");
    const payload = base();
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", "dev-fallback").update(body).digest().toString("base64url");
    expect(verifyInviteToken(`${body}.${sig}`)).toBeNull();
  });

  it("sem secret nenhum, sign+verify funciona no mesmo processo (fallback aleatório efêmero)", () => {
    for (const s of SECRETS) vi.stubEnv(s, "");
    const token = signInviteToken(base());
    expect(verifyInviteToken(token)).toEqual(base());
  });

  it("TERCEIRO ESTADO: INVITE_TOKEN_SECRET presente e VAZIO cai para INTERNAL_SECRET", () => {
    // Doutrina do env-vazia-no-exemplo: quem copia o .env.example recebe a
    // variável PRESENTE e VAZIA — e "" não pode virar chave HMAC nem ativar o
    // fallback aleatório quando INTERNAL_SECRET existe.
    vi.stubEnv("INVITE_TOKEN_SECRET", "");
    vi.stubEnv("INTERNAL_SECRET", "segredo-geral");
    const token = signInviteToken(base());

    expect(verifyInviteToken(token)).toEqual(base());

    // Assinado com o geral (não com efêmero): forjar com o geral verifica;
    // se tivesse caído no segredo efêmero do processo, NÃO verificaria.
    const body = token.split(".")[0]!;
    const sigGeral = createHmac("sha256", "segredo-geral").update(body).digest().toString("base64url");
    expect(verifyInviteToken(`${body}.${sigGeral}`)).toEqual(base());
  });

  it("INVITE_TOKEN_SECRET dedicado vence INTERNAL_SECRET", () => {
    vi.stubEnv("INVITE_TOKEN_SECRET", "segredo-dedicado");
    vi.stubEnv("INTERNAL_SECRET", "segredo-geral");
    const token = signInviteToken(base());

    // Assinado com o dedicado: verifica.
    expect(verifyInviteToken(token)).toEqual(base());

    // Forjado com o geral: recusa — prova de que o dedicado foi o usado.
    const body = token.split(".")[0]!;
    const sigErrada = createHmac("sha256", "segredo-geral").update(body).digest().toString("base64url");
    expect(verifyInviteToken(`${body}.${sigErrada}`)).toBeNull();
  });
});

  it("rejects signed machine/unknown roles and malformed identities", () => {
    for (const role of ["ai_operator", "superadmin", ""]) {
      expect(verifyInviteToken(signInviteToken({ ...base(), role }))).toBeNull();
    }
    expect(verifyInviteToken(signInviteToken({ ...base(), organization_id: "not-uuid" }))).toBeNull();
  });
  it("preserves signed inviter and issuance time", () => {
    const p = { ...base(), invited_by: "33333333-3333-4333-8333-333333333333", iat: Math.floor(Date.now()/1000) };
    expect(verifyInviteToken(signInviteToken(p))).toEqual(p);
  });
