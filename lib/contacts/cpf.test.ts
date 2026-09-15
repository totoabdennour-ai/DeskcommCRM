import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashCpf, normalizeCpf } from "./cpf";

/**
 * Modelo de dado do CPF — Fase 1 (docs/our-product/DECISIONS.md (D17)).
 *
 * A decisão é HASH PSEUDÔNIMO, sem criptografia reversível. Este teste trava
 * as duas propriedades que o modelo exige:
 *  1. o hash é DETERMÍNICO sobre a normalização (busca por igualdade);
 *  2. o caminho de cifragem foi EXTIRPADO — o arquivo não exporta mais
 *     `encryptCpfSql`, e nenhuma linha de app/lib/workers tenta RPC
 *     `encrypt_cpf` (que nunca existiu no schema).
 */
describe("cpf — modelo pseudônimo (Fase 1)", () => {
  it("normaliza para só dígitos", () => {
    expect(normalizeCpf("529.982.247-25")).toBe("52998224725");
    expect(normalizeCpf("52998224725")).toBe("52998224725");
  });

  it("hash é determinístico e igual entre formatações diferentes", () => {
    expect(hashCpf("529.982.247-25")).toBe(hashCpf("52998224725"));
    expect(hashCpf("52998224725")).toBe(
      createHash("sha256").update("52998224725").digest("hex"),
    );
  });

  it("hash tem 64 hex e não contém o plaintext", () => {
    const h = hashCpf("52998224725");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("52998224725");
  });

  it("não existe mais caminho de cifragem (encrypt_cpf extirpado)", async () => {
    // O módulo não exporta mais encryptCpfSql:
    const mod = await import("./cpf");
    expect(Object.keys(mod)).not.toContain("encryptCpfSql");

    // E nenhum código-fonte CHAMA o RPC inexistente. A busca é por chamada
    // (nome + parêntese / rpc com o literal), não por menção: os comentários
    // documentais de lib/contacts/cpf.ts e lib/env.ts citam o nome histórico
    // de propósito, e é correto que continuem citando.
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raiz = join(__dirname, "..", "..");
    const alvos: string[] = [];
    const varrer = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const caminho = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".next") continue;
          varrer(caminho);
        } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts")) {
          alvos.push(caminho);
        }
      }
    };
    for (const dir of ["lib", "app", "workers"]) varrer(join(raiz, dir));
    const chamadas = alvos.filter((c) => {
      const fonte = readFileSync(c, "utf8");
      return (
        fonte.includes("encryptCpfSql(") ||
        fonte.includes('rpc("encrypt_cpf"') ||
        fonte.includes("rpc('encrypt_cpf'")
      );
    });
    expect(chamadas).toEqual([]);
  });
});
