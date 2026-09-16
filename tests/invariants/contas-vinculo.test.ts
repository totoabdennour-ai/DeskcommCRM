import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * CONTAS B2B — O VÍNCULO CONTATO↔CONTA TEM AUTORIDADE NO BANCO (0239, Fase 2).
 *
 * A rota de contatos valida same-org com 422 legível, mas a validação de API
 * é cortesia: quem fala direto com o banco (RPC, worker, DBA) não passa por
 * ela. A FK simples (`contacts.account_id → accounts.id`) NÃO enxerga tenant —
 * sem o `trg_contacts_valida_conta`, um insert direto vincularia o contato da
 * org A à conta da org B, e o painel de pricing da Fase 3-4 acharia isso
 * normal. Aqui se prova, com writes SEM RLS (role postgres), que:
 *
 *   1. vínculo cross-org é RECUSADO (23514) pelo gatilho;
 *   2. vínculo same-org passa (controle positivo);
 *   3. `external_id` é único POR ORGANIZAÇÃO (23505) e REPETIDO entre orgs é
 *      permitido — é referência de ERP, não identidade global;
 *   4. remover a conta NÃO apaga contato: `account_id` vira NULL (SET NULL).
 *
 * Roda contra o Postgres efêmero de `pnpm test:db` (scripts/test-db.sh),
 * igual ao rls-isolation — mesmo mecanismo, outro invariante.
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

const ORG_A = "cccccccc-0000-4000-8000-000000000001";
const ORG_B = "cccccccc-0000-4000-8000-000000000002";
const CONTA_A = "cccccccc-1000-4000-8000-000000000001";
const CONTA_B = "cccccccc-1000-4000-8000-000000000002";
const CONTATO_A = "cccccccc-2000-4000-8000-000000000001";

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_A}', 'contas-inv-a', 'Contas Invariante A', 'Contas A'),
             ('${ORG_B}', 'contas-inv-b', 'Contas Invariante B', 'Contas B')
      on conflict (id) do nothing;
    insert into public.accounts (id, organization_id, name, external_id)
      values ('${CONTA_A}', '${ORG_A}', 'Conta A', 'ERP-A'),
             ('${CONTA_B}', '${ORG_B}', 'Conta B', 'ERP-B')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name)
      values ('${CONTATO_A}', '${ORG_A}', 'Contato da Conta A')
      on conflict (id) do nothing;
  `);
});

describe("contas — o vínculo contato↔conta é da mesma organização (0239)", () => {
  it("CONTROLE: vínculo same-org passa", () => {
    expect(() =>
      sql(`
        update public.contacts set account_id = '${CONTA_A}'
        where id = '${CONTATO_A}';
      `),
    ).not.toThrow();
  });

  it("vínculo cross-org é RECUSADO pelo gatilho (23514), mesmo sem RLS", () => {
    // Writes como postgres = fora de qualquer policy. A única barreira aqui é
    // o trigger — é exatamente o que o torna autoridade.
    let stderr = "";
    try {
      sql(`
        update public.contacts set account_id = '${CONTA_B}'
        where id = '${CONTATO_A}';
      `);
    } catch (e) {
      stderr = String((e as { stderr?: string }).stderr ?? (e as { message?: string }).message);
    }
    expect(stderr).toMatch(/23514/);
    expect(stderr).toMatch(/nao pertence a organizacao/);
  });

  it("external_id duplicado NA MESMA org recusa (23505)", () => {
    let stderr = "";
    try {
      sql(`
        insert into public.accounts (organization_id, name, external_id)
        values ('${ORG_A}', 'Duplicada', 'ERP-A');
      `);
    } catch (e) {
      stderr = String((e as { stderr?: string }).stderr ?? (e as { message?: string }).message);
    }
    expect(stderr).toMatch(/23505/);
  });

  it("external_id IGUAL entre orgs DIFERENTES é permitido (é referência por org)", () => {
    expect(() =>
      sql(`
        insert into public.accounts (organization_id, name, external_id)
        values ('${ORG_B}', 'Homônima', 'ERP-A');
      `),
    ).not.toThrow();
  });

  it("remover a conta NÃO apaga contato: account_id vira NULL (SET NULL)", () => {
    sql(`
      insert into public.accounts (id, organization_id, name)
        values ('cccccccc-1000-4000-8000-000000000099', '${ORG_A}', 'Efêmera')
      on conflict (id) do nothing;
      update public.contacts set account_id = 'cccccccc-1000-4000-8000-000000000099'
        where id = '${CONTATO_A}';
      delete from public.accounts where id = 'cccccccc-1000-4000-8000-000000000099';
    `);
    const conta = sql(`
      select coalesce(account_id::text, 'NULL') from public.contacts
      where id = '${CONTATO_A}';
    `);
    const contatoVivo = sql(`
      select count(*) from public.contacts where id = '${CONTATO_A}';
    `);
    expect(contatoVivo).toBe("1");
    expect(conta).toBe("NULL");
  });
});
