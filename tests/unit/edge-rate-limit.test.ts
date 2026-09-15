import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rate limit de BORDA — Fase 1, risco R4 (docs/our-product/08).
 *
 * O módulo roda no middleware (Edge): o contrato que os testes travam é
 *  - regra por prefixo cobre a superfície inteira (rota nova nasce limitada);
 *  - SEM IP identificável, NÃO limita (doutrina do balde global — limitar
 *    sem origem é DoS de custo zero contra a própria instalação);
 *  - superfície FORA da lista nunca é barrada;
 *  - erro inesperado do limitador é FAIL-OPEN (borda viva > limite perfeito).
 */

const { checkRateLimit } = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit }));

const { EDGE_RATE_LIMITS, regraDeBorda, ipDaBorda, edgeRateLimited } = await import(
  "@/lib/auth/rate-limit-edge"
);

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockResolvedValue({ allowed: true, count: 1, limit: 120, window_sec: 60 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const headers = (entries: Record<string, string>): Headers =>
  new Headers(entries) as unknown as Headers;

describe("regraDeBorda — cobertura por prefixo", () => {
  it("cobre cron, internal, mcp, system e auth/confirm", () => {
    expect(regraDeBorda("/api/v1/cron/event-log-drain")).not.toBeNull();
    expect(regraDeBorda("/api/v1/cron/recover-stuck-messages?x=1") === null).toBe(false);
    expect(regraDeBorda("/api/internal/agents/run")).not.toBeNull();
    expect(regraDeBorda("/api/mcp")).not.toBeNull();
    expect(regraDeBorda("/api/v1/system/agent")).not.toBeNull();
    expect(regraDeBorda("/auth/confirm")).not.toBeNull();
  });

  it("não toca no que não é da lista (webhooks, app, health)", () => {
    expect(regraDeBorda("/api/v1/webhooks/waha/abc")).toBeNull();
    expect(regraDeBorda("/api/v1/webhooks/in/tok")).toBeNull();
    expect(regraDeBorda("/app/inbox")).toBeNull();
    expect(regraDeBorda("/api/v1/health")).toBeNull();
    expect(regraDeBorda("/login")).toBeNull();
  });

  it("cada superfície listada tem teto declarado", () => {
    for (const regra of EDGE_RATE_LIMITS) {
      expect(regra.limit).toBeGreaterThan(0);
      expect(regra.windowSec).toBeGreaterThan(0);
    }
  });
});

describe("ipDaBorda — origem do cliente", () => {
  it("usa o primeiro x-forwarded-for", () => {
    expect(
      ipDaBorda({ headers: headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }) } as never),
    ).toBe("1.2.3.4");
  });

  it("cai para x-real-ip", () => {
    expect(ipDaBorda({ headers: headers({ "x-real-ip": "5.6.7.8" }) } as never)).toBe("5.6.7.8");
  });

  it("null quando não há header nenhum (kit sem proxy)", () => {
    expect(ipDaBorda({ headers: headers({}) } as never)).toBeNull();
  });
});

describe("edgeRateLimited — a decisão", () => {
  it("barra quando o contador estoura", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, count: 121, limit: 120, window_sec: 60 });
    expect(await edgeRateLimited("/api/mcp", "1.2.3.4")).toBe(true);
  });

  it("passa quando abaixo do teto", async () => {
    expect(await edgeRateLimited("/api/mcp", "1.2.3.4")).toBe(false);
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("edge:/api/mcp:ip:"),
      expect.any(Number),
      60,
    );
  });

  it("NÃO limita sem IP (balde global seria DoS de custo zero)", async () => {
    expect(await edgeRateLimited("/api/mcp", null)).toBe(false);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("NÃO limita fora da lista", async () => {
    expect(await edgeRateLimited("/app/inbox", "1.2.3.4")).toBe(false);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("fail-open: exceção inesperada do limitador libera a requisição", async () => {
    checkRateLimit.mockRejectedValue(new Error("boom"));
    expect(await edgeRateLimited("/api/mcp", "1.2.3.4")).toBe(false);
  });
});
