import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * PRECIFICAÇÃO B2B — O VÍNCULO TEM AUTORIDADE NO BANCO (0240, Fase 3).
 *
 * A rota valida same-org com 422 legível, mas quem fala direto com o banco
 * (RPC, worker, DBA) não passa por ela. As FKs simples (item→lista, item→
 * produto, account→lista) NÃO enxergam tenant — sem os gatilhos, um insert
 * direto amarraria a lista da org A ao produto/org B, e o resolver serviria
 * um preço de outro tenant como se fosse da casa. Aqui se prova, com writes
 * SEM RLS (role postgres), que:
 *
 *   1. item apontando para LISTA de outra org é RECUSADO (23514);
 *   2. item apontando para PRODUTO de outra org é RECUSADO (23514);
 *   3. vínculo same-org passa (controle positivo);
 *   4. accounts.price_list_id de outra org é RECUSADO (23514);
 *   5. remover o PRODUTO remove o item junto (cascade — item sem produto não
 *      tem sentido) e NÃO remove a lista.
 *
 * Roda contra o Postgres efêmero de `pnpm test:db` (scripts/test-db.sh),
 * igual ao rls-isolation.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)",
  );
}
// Anotação explícita: o estreitamento do guard NÃO atravessa a fronteira da
// função `sql` — dentro dela `container` volta a ser `string | undefined`.
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG_A = "dddddddd-0000-4000-8000-000000000001";
const ORG_B = "dddddddd-0000-4000-8000-000000000002";
const LISTA_A = "dddddddd-1000-4000-8000-000000000001";
const LISTA_B = "dddddddd-1000-4000-8000-000000000002";
const PRODUTO_A = "dddddddd-2000-4000-8000-000000000001";
const PRODUTO_B = "dddddddd-2000-4000-8000-000000000002";
const CONTA_A = "dddddddd-3000-4000-8000-000000000001";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_A}', 'preco-inv-a', 'Preço Invariante A', 'Preços A'),
             ('${ORG_B}', 'preco-inv-b', 'Preço Invariante B', 'Preços B')
      on conflict (id) do nothing;
    insert into public.price_lists (id, organization_id, nome, moeda)
      values ('${LISTA_A}', '${ORG_A}', 'Lista A', 'BRL'),
             ('${LISTA_B}', '${ORG_B}', 'Lista B', 'BRL')
      on conflict (id) do nothing;
    insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents, moeda)
      values ('${PRODUTO_A}', '${ORG_A}', 'PRECO-INV-A', 'Produto A', 1000, 'BRL'),
             ('${PRODUTO_B}', '${ORG_B}', 'PRECO-INV-B', 'Produto B', 2000, 'BRL')
      on conflict (id) do nothing;
    insert into public.accounts (id, organization_id, name)
      values ('${CONTA_A}', '${ORG_A}', 'Conta A')
      on conflict (id) do nothing;
  `);
});

/** Extrai o SQLSTATE da mensagem de erro do psql (23514 etc.), ou vazio. */
function codigoDeErro(e: unknown): string {
  const texto = String((e as { stderr?: string }).stderr ?? (e as { message?: string }).message);
  const m = /SQLSTATE (\d{5})|(\d{5})/.exec(texto);
  return m ? (m[1] ?? m[2] ?? "") : texto.slice(0, 200);
}

describe("price_list_items — item pertence à lista E ao produto DA MESMA ORG (0240)", () => {
  it("CONTROLE: item same-org passa", () => {
    expect(() =>
      sql(`
        insert into public.price_list_items (organization_id, price_list_id, product_id, preco_cents)
        values ('${ORG_A}', '${LISTA_A}', '${PRODUTO_A}', 900);
      `),
    ).not.toThrow();
  });

  it("item apontando para LISTA de outra org é RECUSADO (23514), mesmo sem RLS", () => {
    let stderr = "";
    try {
      sql(`
        insert into public.price_list_items (organization_id, price_list_id, product_id, preco_cents)
        values ('${ORG_A}', '${LISTA_B}', '${PRODUTO_A}', 900);
      `);
    } catch (e) {
      stderr = codigoDeErro(e);
    }
    expect(stderr).toBe("23514");
  });

  it("item apontando para PRODUTO de outra org é RECUSADO (23514), mesmo sem RLS", () => {
    let stderr = "";
    try {
      sql(`
        insert into public.price_list_items (organization_id, price_list_id, product_id, preco_cents)
        values ('${ORG_A}', '${LISTA_A}', '${PRODUTO_B}', 900);
      `);
    } catch (e) {
      stderr = codigoDeErro(e);
    }
    expect(stderr).toBe("23514");
  });

  it("preço NEGATIVO é recusado pelo CHECK (23P01/23514 do check é 23514? não: 23514 é check_violation genérico)", () => {
    // O CHECK `price_list_items_preco_nao_negativo` fala 23514 — o MESMO
    // código do gatilho. O que importa aqui: não entra preço negativo.
    let stderr = "";
    try {
      sql(`
        insert into public.price_list_items (organization_id, price_list_id, product_id, preco_cents)
        values ('${ORG_A}', '${LISTA_A}', '${PRODUTO_A}', -1);
      `);
    } catch (e) {
      stderr = codigoDeErro(e);
    }
    expect(stderr).toBe("23514");
  });

  it("remover o PRODUTO remove o item junto (cascade) e PRESERVA a lista", () => {
    sql(`
      insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents, moeda)
        values ('dddddddd-2000-4000-8000-000000000099', '${ORG_A}', 'PRECO-EFEMERO', 'Efêmero', 500, 'BRL')
      on conflict (id) do nothing;
      insert into public.price_list_items (organization_id, price_list_id, product_id, preco_cents)
        values ('${ORG_A}', '${LISTA_A}', 'dddddddd-2000-4000-8000-000000000099', 400);
      delete from public.catalog_products where id = 'dddddddd-2000-4000-8000-000000000099';
    `);
    const item = sql(`
      select count(*) from public.price_list_items
      where product_id = 'dddddddd-2000-4000-8000-000000000099';
    `);
    const listaViva = sql(`
      select count(*) from public.price_lists where id = '${LISTA_A}';
    `);
    expect(item).toBe("0");
    expect(listaViva).toBe("1");
  });
});

describe("accounts.price_list_id — a lista da conta é da MESMA ORG (0240)", () => {
  it("CONTROLE: same-org passa", () => {
    expect(() =>
      sql(`
        update public.accounts set price_list_id = '${LISTA_A}' where id = '${CONTA_A}';
      `),
    ).not.toThrow();
  });

  it("lista de outra org é RECUSADA (23514), mesmo sem RLS", () => {
    let stderr = "";
    try {
      sql(`
        update public.accounts set price_list_id = '${LISTA_B}' where id = '${CONTA_A}';
      `);
    } catch (e) {
      stderr = codigoDeErro(e);
    }
    expect(stderr).toBe("23514");
  });

  it("remover a LISTA não remove a conta: price_list_id vira NULL (SET NULL)", () => {
    sql(`
      insert into public.price_lists (id, organization_id, nome, moeda)
        values ('dddddddd-1000-4000-8000-000000000099', '${ORG_A}', 'Efêmera', 'BRL')
      on conflict (id) do nothing;
      update public.accounts set price_list_id = 'dddddddd-1000-4000-8000-000000000099'
        where id = '${CONTA_A}';
      delete from public.price_lists where id = 'dddddddd-1000-4000-8000-000000000099';
    `);
    const contaViva = sql(`select count(*) from public.accounts where id = '${CONTA_A}';`);
    const lista = sql(`
      select coalesce(price_list_id::text, 'NULL') from public.accounts where id = '${CONTA_A}';
    `);
    expect(contaViva).toBe("1");
    expect(lista).toBe("NULL");
  });
});
