import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * EVENTO DE DOMÍNIO EMITIDO COM `await` — NUNCA fire-and-forget.
 *
 * ─── O defeito, medido (Fase 0, docs/our-product/07 §10) ────────────────────
 *
 * Seis pontos emitiam `void admin.from("event_log").insert(...)` (um deles
 * ainda com `.then(({ error }) => console.error(...))`): não aguardavam, não
 * eram transacionais, não eram retentados. Crash, erro de rede ou deploy no
 * meio da escrita PERDIA o evento — `tenant.suspended`, `ai_agent.published`,
 * `incident.resolved` — sem log, sem rastro, sem consumer. O conserto por
 * instância (await nos seis) deixa o PRÓXIMO emitter nascer fire-and-forget,
 * e o modo de falha é mudo. Daí o guarda AST: alcança arquivo que ainda não
 * existe.
 *
 * Como o teste de `cron-audita-so-quando-ha-efeito`: ancorado no AST e não em
 * regex, porque prosa deste repo cita `event_log` em comentário o tempo todo.
 *
 * O que É permitido:
 *  - `await admin.from("event_log").insert(...)` (direto ou em destruturação);
 *  - o helper canônico `emitirEventoAguardado` (`lib/event-log/emitir.ts`),
 *    que aguarda internamente;
 *  - emit_event()/trigger SQL (não passa por `.from("event_log")`).
 *
 * `.select`/`.update`/`.upsert` em event_log estão FORA do escopo: o gate é
 * sobre EMISSÃO de evento novo.
 */

const RAIZ = join(__dirname, "..", "..");
const DIRETORIOS = ["app", "lib", "workers"] as const;

export function insertsSemAwait(fonte: string, nomeDoArquivo: string): number[] {
  const arquivo = ts.createSourceFile(nomeDoArquivo, fonte, ts.ScriptTarget.Latest, true);
  const infratoras: number[] = [];

  const ehInsertDeEventLog = (no: ts.Node): no is ts.CallExpression =>
    ts.isCallExpression(no) &&
    ts.isPropertyAccessExpression(no.expression) &&
    no.expression.name.text === "insert" &&
    ((): boolean => {
      // O receiver precisa ser uma chain `.from("event_log")` (direta ou com
      // métodos PostgREST no meio, ex. `.from("event_log").insert`).
      let alvo: ts.Expression = no.expression.expression;
      for (let profundidade = 0; profundidade < 8 && ts.isCallExpression(alvo); profundidade++) {
        const chamada = alvo;
        const primeiroArg = chamada.arguments[0];
        if (
          primeiroArg !== undefined &&
          ts.isPropertyAccessExpression(chamada.expression) &&
          chamada.expression.name.text === "from" &&
          chamada.arguments.length === 1 &&
          ts.isStringLiteral(primeiroArg) &&
          primeiroArg.text === "event_log"
        ) {
          return true;
        }
        alvo = chamada.expression;
      }
      return false;
    })();

  const visitar = (no: ts.Node): void => {
    if (ehInsertDeEventLog(no)) {
      // Sobe até achar AwaitExpression (ok) ou o fim da expressão (infratora).
      let ancestral: ts.Node = no.parent;
      let sobreviveu = false;
      while (ancestral && !ts.isSourceFile(ancestral)) {
        if (ts.isAwaitExpression(ancestral)) {
          sobreviveu = true;
          break;
        }
        if (ts.isVariableDeclaration(ancestral) || ts.isReturnStatement(ancestral)) {
          // `const x = ...` sem await chegou aqui sem AwaitExpression → infratora.
          break;
        }
        if (ts.isExpressionStatement(ancestral) || ts.isArrowFunction(ancestral)) break;
        ancestral = ancestral.parent;
      }
      if (!sobreviveu) infratoras.push(arquivo.getLineAndCharacterOfPosition(no.getStart()).line + 1);
      return;
    }
    ts.forEachChild(no, visitar);
  };

  visitar(arquivo);
  return infratoras;
}

function arquivosDeFonte(dir: string): string[] {
  const saida: string[] = [];
  const varrer = (atual: string): void => {
    for (const e of readdirSync(atual, { withFileTypes: true })) {
      const caminho = join(atual, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        varrer(caminho);
      } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
        saida.push(caminho);
      }
    }
  };
  varrer(dir);
  return saida;
}

describe("emissão de evento aguardada (Fase 1)", () => {
  it("nenhum `.from(\"event_log\").insert` sem await em app/lib/workers", () => {
    const infratoras: { arquivo: string; linhas: number[] }[] = [];
    for (const dir of DIRETORIOS) {
      const raiz = join(RAIZ, dir);
      if (!statSync(raiz, { throwIfNoEntry: false })) continue;
      for (const caminho of arquivosDeFonte(raiz)) {
        const fonte = readFileSync(caminho, "utf8");
        const linhas = insertsSemAwait(fonte, caminho);
        if (linhas.length) infratoras.push({ arquivo: caminho, linhas });
      }
    }
    expect(
      infratoras.map((i) => `${i.arquivo.replace(RAIZ, "")}: linhas ${i.linhas.join(",")}`),
    ).toEqual([]);
  });

  it("o guarda reconhece os padrões (controle interno)", () => {
    const aguardado = `const { error } = await admin.from("event_log").insert({ x: 1 });`;
    const voidFire = `void admin.from("event_log").insert({ x: 1 });`;
    const thenFire = `admin.from("event_log").insert({ x: 1 }).then(({ error }) => { console.error(error); });`;
    const plainFire = `admin.from("event_log").insert({ x: 1 });`;
    const outraTabela = `const { error } = await admin.from("outra").insert({ x: 1 });`;
    const selectOk = `const r = await admin.from("event_log").select("*");`;

    expect(insertsSemAwait(aguardado, "a.ts")).toEqual([]);
    expect(insertsSemAwait(thenFire, "b.ts")).toEqual([1]);
    expect(insertsSemAwait(voidFire, "c.ts")).toEqual([1]);
    expect(insertsSemAwait(plainFire, "d.ts")).toEqual([1]);
    expect(insertsSemAwait(outraTabela, "e.ts")).toEqual([]);
    expect(insertsSemAwait(selectOk, "f.ts")).toEqual([]);
  });
});
