import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * HEADERS DE SEGURANÇA — Fase 1, risco R5 (docs/our-product/08): sem CSP e sem
 * HSTS em lugar nenhum (app e Caddy). O `next.config.ts` passa a emitir ambos
 * em toda resposta; este guard reprova a regressão silenciosa (um refactor que
 * derrube o bloco `headers()` volta a expor a app sem CSP com CI verde).
 *
 * O guard lê o FONTE do next.config.ts, não o header renderizado — executar o
 * config aqui exigiria carregar @sentry/nextjs no vitest. O que travamos é a
 * PRESENÇA e as diretivas de maior valor; a efetividade ponta a ponta é
 * provada pelo e2e de headers no CI.
 */

const raiz = join(__dirname, "..", "..");
const fonte = readFileSync(join(raiz, "next.config.ts"), "utf8");

describe("headers de segurança no next.config.ts (Fase 1)", () => {
  it("emite Strict-Transport-Security", () => {
    expect(fonte).toContain('"Strict-Transport-Security"');
    expect(fonte).toMatch(/max-age=\d+/);
  });

  it("emite Content-Security-Policy com as diretivas de maior valor", () => {
    expect(fonte).toContain('"Content-Security-Policy"');
    for (const diretiva of [
      "default-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(fonte, `faltou: ${diretiva}`).toContain(diretiva);
    }
  });

  it("CSP cobre script/style/img/media/connect/worker", () => {
    for (const diretiva of [
      "script-src",
      "style-src",
      "img-src",
      "media-src",
      "connect-src 'self'",
      "worker-src",
    ]) {
      // `connect-src` é montado em template literal (origem Supabase dinâmica),
      // os demais são strings duplas no fonte — por isso só se exige a presença
      // do nome da directive + conteúdo, sem exigir a aspa inicial.
      expect(fonte, `faltou: ${diretiva}`).toContain(diretiva);
    }
  });

  it("mantém os headers que já existiam", () => {
    expect(fonte).toContain('"X-Content-Type-Options"');
    expect(fonte).toContain('"X-Frame-Options"');
    expect(fonte).toContain('"Referrer-Policy"');
    expect(fonte).toContain('"Permissions-Policy"');
  });
});
