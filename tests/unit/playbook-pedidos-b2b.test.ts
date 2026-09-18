import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PLAYBOOK B2B (Fase 5) — A CAMADA DE PROMPT NÃO É FONTE DE VERDADE DE DINHEIRO.
 *
 * A seção "Pedidos no atacado" orienta o agente a operar rascunhos pelas tools
 * do Order Engine. Este gate trava as TRÊS propriedades não-negociáveis:
 *
 *   1. CONHECE as cinco tools do ciclo (contexto → busca → criar/atualizar →
 *      consultar) — precedência do `playbook-cita-a-ferramenta` (conhecer é
 *      pré-condição de concordar);
 *   2. PROÍBE preço inventado — o texto tem de dizer que o preço vem da
 *      ferramenta/sistema e conter a proibição explícita;
 *   3. NÃO CARREGA política de preço — nenhum literal de moeda/valor no texto:
 *      preços vivem em `catalog_products`/`price_lists` e são resolvidos pelo
 *      resolver (doc 24). Um playbook com "R$ 199" é uma segunda fonte de
 *      verdade nascendo por baixo do resolver.
 *
 * E mantém o compromisso B1: confirmação é humana.
 */

const RAIZ = process.cwd();
const fonte = readFileSync(join(RAIZ, "lib", "agent-engine", "playbooks", "platform.md"), "utf8");

const secao = (() => {
  const inicio = fonte.indexOf("## Pedidos no atacado (B2B)");
  if (inicio === -1) return null;
  const proxima = fonte.indexOf("\n## ", inicio + 1);
  return fonte.slice(inicio, proxima === -1 ? undefined : proxima);
})();

describe("playbook plataforma — seção Pedidos B2B (Fase 5)", () => {
  it("a seção existe (o gate não é vazio)", () => {
    expect(secao).not.toBeNull();
  });

  it("cita as cinco tools do ciclo de pedido", () => {
    for (const tool of [
      "crm_get_order_context",
      "crm_search_products",
      "crm_create_order",
      "crm_update_order_draft",
      "crm_get_order",
    ]) {
      expect(secao, `faltou citar ${tool}`).toContain(tool);
    }
  });

  it("proíbe invenção de preço e amarra o preço à resposta da ferramenta", () => {
    expect(secao).toMatch(/nunca calcula|nunca estima/i);
    expect(secao).toMatch(/não veio na resposta da ferramenta|não veio na resposta/i);
    expect(secao).toMatch(/nunca confirme|nunca confirma/i);
  });

  it("NÃO carrega política de preço (nenhum literal de dinheiro na seção)", () => {
    const literaisDeDinheiro = secao!.match(/R\$\s?\d|US\$\s?\d|\d+\s?(reais|centavos)/gi);
    expect(literaisDeDinheiro, `preço no prompt: ${literaisDeDinheiro?.join(", ")}`).toBeNull();
  });

  it("manda escalar pelo flag determinístico, não por julgamento do modelo", () => {
    expect(secao).toContain("escalar_para_humano");
    expect(secao).toContain("request_human_handoff");
  });
});
