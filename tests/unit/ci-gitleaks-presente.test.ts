import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * VARREDURA DE SECRETS NO CI — Fase 1, risco R7 (docs/our-product/08): o repo
 * é público e não tinha gitleaks/trufflehog em lugar nenhum. O job `secrets`
 * do ci.yml roda `gitleaks-action@v2` sobre o HISTÓRICO inteiro
 * (fetch-depth: 0 — secret commitado não deixa de vazar por ser removido).
 *
 * Este guard reprova o PR que remova o job silenciosamente (ou que desarme o
 * fetch-depth), o mesmo modo de falha que o `cron-routes-scheduled.test.ts`
 * previne para as linhas de crontab.
 */

const raiz = join(__dirname, "..", "..");
const ci = readFileSync(join(raiz, ".github", "workflows", "ci.yml"), "utf8");

describe("CI — varredura de secrets (Fase 1)", () => {
  it("ci.yml tem o job `secrets` com gitleaks", () => {
    expect(ci).toMatch(/^  secrets:$/m);
    expect(ci).toContain("gitleaks/gitleaks-action@v2");
  });

  it("gitleaks roda sobre o histórico inteiro (fetch-depth: 0)", () => {
    const job = ci.split(/^  secrets:$/m)[1] ?? "";
    expect(job).toContain("fetch-depth: 0");
  });

  it("os jobs de verify e invariants continuam de pé (guard anti-regressão)", () => {
    expect(ci).toMatch(/^  verify:$/m);
    expect(ci).toMatch(/^  invariants:$/m);
    expect(ci).toContain("pnpm test:db");
  });
});
