import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * ORDER ENGINE — A AUTORIDADE É O BANCO (0241, Fase 4).
 *
 * As rotas e o engine TS validam antes, mas quem fala direto com o banco
 * (RPC, worker, DBA) só encontra os guardas SQL. Aqui se prova, com writes
 * SEM RLS (role postgres), que:
 *
 *   1. pedido NATIVO sem conta é RECUSADO pelo CHECK (B7);
 *   2. `fn_criar_pedido` grava pedido + linhas + evento `created` + event_log
 *      NO MESMO COMMIT (outbox — doc 07 §6) e calcula o total (Σ qty × preço);
 *   3. `fn_confirmar_pedido` só aceita draft (transição inválida recusada);
 *   4. a conta do pedido e o produto da linha de outra org são RECUSADOS (23514);
 *   5. o parciais: `fn_editar_rascunho` recalcula; `fn_cancelar_pedido`
 *      registrou motivo; event_log ganhou `order.*`.
 *
 * Roda contra o Postgres efêmero de `pnpm test:db`, igual ao rls-isolation.
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
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function sqlQueFalha(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    const texto = String((e as { stderr?: string }).stderr ?? (e as { message?: string }).message);
    const m = /SQLSTATE (\d{5})|(\d{5})/.exec(texto);
    return m ? (m[1] ?? m[2] ?? "") : texto.slice(0, 160);
  }
}

const ORG_A = "eeeeeeee-0000-4000-8000-000000000001";
const ORG_B = "eeeeeeee-0000-4000-8000-000000000002";
const CONTA_A = "eeeeeeee-1000-4000-8000-000000000001";
const PRODUTO_A = "eeeeeeee-2000-4000-8000-000000000001";
const PRODUTO_B = "eeeeeeee-2000-4000-8000-000000000002";
const ACTOR = "eeeeeeee-3000-4000-8000-000000000001";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${ACTOR}', 'orders-inv@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_A}', 'orders-inv-a', 'Orders Invariante A', 'Orders A'),
             ('${ORG_B}', 'orders-inv-b', 'Orders Invariante B', 'Orders B')
      on conflict (id) do nothing;
    insert into public.accounts (id, organization_id, name)
      values ('${CONTA_A}', '${ORG_A}', 'Conta Orders A')
      on conflict (id) do nothing;
    insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents, moeda)
      values ('${PRODUTO_A}', '${ORG_A}', 'ORD-INV-A', 'Produto Orders A', 1000, 'BRL'),
             ('${PRODUTO_B}', '${ORG_B}', 'ORD-INV-B', 'Produto Orders B', 2000, 'BRL')
      on conflict (id) do nothing;
  `);
});

describe("orders — pedido nativo EXIGE conta (B7, CHECK)", () => {
  it("INSERT de origin='manual' sem account_id é recusado (23514 do CHECK)", () => {
    expect(
      sqlQueFalha(`
        insert into public.orders (organization_id, external_id, external_provider, origin, status, total_cents, currency, ordered_at)
        values ('${ORG_A}', 'PED-SEM-CONTA', 'manual', 'manual', 'draft', 0, 'BRL', now());
      `),
    ).toBe("23514");
  });

  it("espelho externo SEM conta continua legal (origin='nuvemshop')", () => {
    expect(() =>
      sql(`
        insert into public.orders (organization_id, external_id, external_provider, origin, status, total_cents, currency, ordered_at)
        values ('${ORG_A}', 'NUVEM-123', 'nuvemshop', 'nuvemshop', 'pending', 5000, 'BRL', now());
      `),
    ).not.toThrow();
  });
});

describe("fn_criar_pedido — outbox no MESMO COMMIT (doc 07 §6)", () => {
  const LINHAS = JSON.stringify([
    { product_id: PRODUTO_A, sku: "ORD-INV-A", nome: "Produto Orders A", quantity: 2,
      unit_price_cents: 900, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
  ]);

  it("CONTROLE: cria draft com total = Σ qty × preço", () => {
    const pedido = sql(`
      select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-INV-1', 'BRL',
        '${LINHAS.replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
    `);
    const total = sql(`
      select total_cents from public.orders where id = '${pedido}';
    `);
    const status = sql(`
      select status from public.orders where id = '${pedido}';
    `);
    expect(status).toBe("draft");
    expect(total).toBe("1800");
  });

  it("evento de domínio + event_log nasceram JUNTOS (mesmo commit)", () => {
    const eventoDominio = sql(`
      select count(*) from public.order_events where kind = 'created'
        and order_id in (select id from public.orders where external_id = 'PED-INV-1');
    `);
    const eventoBarramento = sql(`
      select count(*) from public.event_log
      where event_type = 'order.created'
        and entity_id in (select id from public.orders where external_id = 'PED-INV-1');
    `);
    expect(eventoDominio).toBe("1");
    expect(eventoBarramento).toBe("1");
  });

  it("conta de OUTRA org é recusada (23514)", () => {
    expect(
      sqlQueFalha(`
        select public.fn_criar_pedido('${ORG_A}', 'eeeeeeee-1000-4000-8000-000000000099', 'PED-X', 'BRL',
          '${LINHAS.replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
      `),
    ).toBe("23514");
  });

  it("produto de OUTRA org na linha é recusado (23514)", () => {
    const linhasInvasoras = JSON.stringify([
      { product_id: PRODUTO_B, sku: "ORD-INV-B", nome: "Produto B", quantity: 1,
        unit_price_cents: 500, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
    ]);
    expect(
      sqlQueFalha(`
        select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-INVASOR', 'BRL',
          '${linhasInvasoras.replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
      `),
    ).toBe("23514");
  });

  it("pedido SEM itens é recusado (23514)", () => {
    expect(
      sqlQueFalha(`
        select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-VAZIO', 'BRL',
          '[]'::jsonb, '${ACTOR}', 'user');
      `),
    ).toBe("23514");
  });
});

describe("fn_confirmar_pedido / fn_editar_rascunho / fn_cancelar_pedido — a máquina de estados", () => {
  const PEDIDO_CONFIRMADO = sql(`
    select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-INV-CONF', 'BRL',
      '${JSON.stringify([
        { product_id: PRODUTO_A, sku: "ORD-INV-A", nome: "Produto A", quantity: 1,
          unit_price_cents: 900, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
      ]).replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
  `);

  it("confirmar recalcula o total das linhas NOVAS e vira 'confirmed'", () => {
    const linhasNovas = JSON.stringify([
      { product_id: PRODUTO_A, sku: "ORD-INV-A", nome: "Produto A", quantity: 3,
        unit_price_cents: 900, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
    ]);
    const total = sql(`
      select public.fn_confirmar_pedido('${ORG_A}', '${PEDIDO_CONFIRMADO}',
        '${linhasNovas.replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
    `);
    const status = sql(`select status from public.orders where id = '${PEDIDO_CONFIRMADO}';`);
    const itens = sql(`select count(*) from public.order_items where order_id = '${PEDIDO_CONFIRMADO}';`);
    expect(total).toBe("2700");
    expect(status).toBe("confirmed");
    expect(itens).toBe("1");
  });

  it("confirmar DUAS VEZES é recusado (só draft confirma)", () => {
    expect(
      sqlQueFalha(`
        select public.fn_confirmar_pedido('${ORG_A}', '${PEDIDO_CONFIRMADO}',
          '${JSON.stringify([
            { product_id: PRODUTO_A, sku: "ORD-INV-A", nome: "Produto A", quantity: 1,
              unit_price_cents: 900, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
          ]).replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
      `),
    ).toBe("23514");
  });

  it("editar rascunho CONFIRMADO é recusado (imutável por esta via)", () => {
    expect(
      sqlQueFalha(`
        select public.fn_editar_rascunho('${ORG_A}', '${PEDIDO_CONFIRMADO}',
          '${JSON.stringify([
            { product_id: PRODUTO_A, sku: "ORD-INV-A", nome: "Produto A", quantity: 1,
              unit_price_cents: 900, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
          ]).replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
      `),
    ).toBe("23514");
  });

  it("cancelar pedidos de OUTRA org é recusado (23514)", () => {
    expect(
      sqlQueFalha(`
        select public.fn_cancelar_pedido('${ORG_B}', '${PEDIDO_CONFIRMADO}', 'motivo', '${ACTOR}', 'user');
      `),
    ).toBe("23514");
  });

  it("cancelar o confirmado funciona e o evento carrega o motivo", () => {
    expect(() =>
      sql(`
        select public.fn_cancelar_pedido('${ORG_A}', '${PEDIDO_CONFIRMADO}', 'cliente desistiu', '${ACTOR}', 'user');
      `),
    ).not.toThrow();
    const status = sql(`select status from public.orders where id = '${PEDIDO_CONFIRMADO}';`);
    const motivo = sql(`
      select payload->>'motivo' from public.order_events
      where order_id = '${PEDIDO_CONFIRMADO}' and kind = 'cancelled'
      order by seq desc limit 1;
    `);
    expect(status).toBe("cancelled");
    expect(motivo).toBe("cliente desistiu");
  });
});

// ─── F4.1 — os dois bloqueadores do freeze review ───────────────────────────

describe("F4.1-1 — orders é SELECT-ONLY para authenticated (sem mutação fora da máquina de estados)", () => {
  const MEMBRO = "eeeeeeee-4000-4000-8000-000000000001";
  const PEDIDO_MEMBRO = sql(`
    select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-F41-MEMBRO', 'BRL',
      '${JSON.stringify([
        { product_id: PRODUTO_A, sku: "ORD-INV-A", nome: "Produto A", quantity: 1,
          unit_price_cents: 900, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
      ]).replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
  `);

  beforeAll(() => {
    sql(`
      insert into auth.users (id, email) values ('${MEMBRO}', 'orders-f41@invariant.test')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${MEMBRO}', '${ORG_A}', 'viewer', now())
        on conflict do nothing;
    `);
  });

  /** UPDATE como o membro autenticado (JWT simulado — caminho de produção). */
  function updateComoMembro(): string {
    try {
      return sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MEMBRO}"}', false);
        update public.orders set total_cents = 1, status = 'confirmed'
          where id = '${PEDIDO_MEMBRO}' returning id;
        reset role;
      `);
    } catch {
      return "";
    }
  }

  it("UPDATE direto do membro NÃO muda nada (0 linhas) — a máquina de estados é a única porta", () => {
    const afetadas = updateComoMembro();
    // RLS sem policy de escrita: o UPDATE não vê linhas mutáveis → zero retorno
    // (ou erro de permissão, dependendo do caminho) — nunca uma mutação.
    expect(afetadas).not.toContain(PEDIDO_MEMBRO);
    const total = sql(`select total_cents from public.orders where id = '${PEDIDO_MEMBRO}';`);
    const status = sql(`select status from public.orders where id = '${PEDIDO_MEMBRO}';`);
    expect(total).toBe("900");
    expect(status).toBe("draft");
  });

  it("INSERT direto do membro é recusado (42501 — violação de RLS sem policy de escrita)", () => {
    const erro = sqlQueFalha(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MEMBRO}"}', false);
      insert into public.orders (organization_id, external_id, external_provider, account_id, origin, status, total_cents, currency, ordered_at)
      values ('${ORG_A}', 'PED-F41-INSERIDO', 'manual', '${CONTA_A}', 'manual', 'draft', 0, 'BRL', now());
      reset role;
    `);
    expect(erro).toBe("42501");
  });

  it("DELETE direto do membro NÃO apaga nada", () => {
    try {
      sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${MEMBRO}"}', false);
        delete from public.orders where id = '${PEDIDO_MEMBRO}';
        reset role;
      `);
    } catch {
      // recusa também é aceitável — o que não pode é apagar
    }
    const vivo = sql(`select count(*) from public.orders where id = '${PEDIDO_MEMBRO}';`);
    expect(vivo).toBe("1");
  });

  it("CONTROLE: a RPC do engine continua criando normalmente (escrita via definer)", () => {
    expect(() =>
      sql(`
        select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-F41-RPC', 'BRL',
          '${JSON.stringify([
            { product_id: PRODUTO_A, sku: "ORD-INV-A", nome: "Produto A", quantity: 1,
              unit_price_cents: 900, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
          ]).replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
      `),
    ).not.toThrow();
  });
});

describe("F4.1-2 — idempotência TRANSACIONAL (mesma transação do pedido)", () => {
  const LINHAS = JSON.stringify([
    { product_id: PRODUTO_A, sku: "ORD-INV-A", nome: "Produto A", quantity: 1,
      unit_price_cents: 900, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
  ]);
  const CHAVE = "pedidos-inv-chave-1";
  // Dupla barra de propósito: dentro do template literal do `sql()` o TS come
  // um nível de escape, e o que precisa chegar ao Postgres é `\xabc123` (bytea).
  const HASH = "\\xabc123";

  it("1ª chamada com chave cria pedido E consome a chave (mesma transação)", () => {
    const r = sql(`
      select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-F41-IDEM', 'BRL',
        '${LINHAS.replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user', '${CHAVE}', '${HASH}'::bytea);
    `);
    const corpo = JSON.parse(r) as { replay: boolean; order_id: string; total_cents: number };
    expect(corpo.replay).toBe(false);
    const chaveGravada = sql(`
      select count(*) from public.idempotency_keys
      where organization_id = '${ORG_A}' and key = '${CHAVE}';
    `);
    expect(chaveGravada).toBe("1");
  });

  it("2ª chamada, MESMO hash → replay do resultado gravado, SEM segundo pedido", () => {
    const r = sql(`
      select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-F41-IDEM-OUTRO-NUMERO', 'BRL',
        '${LINHAS.replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user', '${CHAVE}', '${HASH}'::bytea);
    `);
    const corpo = JSON.parse(r) as { replay: boolean; order_id: string };
    expect(corpo.replay).toBe(true);
    const pedidos = sql(`
      select count(*) from public.orders
      where account_id = '${CONTA_A}' and external_id like 'PED-F41%';
    `);
    // PED-F41-IDEM (1º) + PED-F41-MEMBRO/RPC do bloco anterior... conta só os
    // de idempotência: o replay NÃO criou 'PED-F41-IDEM-OUTRO-NUMERO'.
    const duplicado = sql(`
      select count(*) from public.orders where external_id = 'PED-F41-IDEM-OUTRO-NUMERO';
    `);
    expect(duplicado).toBe("0");
    expect(pedidos).toBe("1");
  });

  it("mesma chave + HASH DIFERENTE → 'idempotency_conflicting_body' (409 na rota)", () => {
    const erro = sqlQueFalha(`
      select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-F41-OUTRO', 'BRL',
        '${LINHAS.replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user', '${CHAVE}', '\\xfe01'::bytea);
    `);
    expect(erro).toBe("P0001");
  });

  it("ROLLBACK não consome a chave: pedido que falha depois do consumo deixa a chave livre", () => {
    // Chave NOVA + produto INVASOR (de outra org): o gatilho da linha falha
    // DEPOIS do insert da chave → a transação inteira rollbacka → nem pedido,
    // nem evento, nem chave consumida.
    const erro = sqlQueFalha(`
      begin;
      select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-F41-ROLLBACK', 'BRL',
        '${JSON.stringify([
          { product_id: PRODUTO_B, sku: "ORD-INV-B", nome: "Produto B", quantity: 1,
            unit_price_cents: 500, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
        ]).replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user', 'pedidos-inv-rollback', '\\xaaa'::bytea);
      rollback;
    `);
    // A execução falha (produto invasor), e o rollback é implícito no psql
    // com ON_ERROR_STOP — o que importa é o estado final:
    const chave = sql(`
      select count(*) from public.idempotency_keys
      where organization_id = '${ORG_A}' and key = 'pedidos-inv-rollback';
    `);
    const pedido = sql(`
      select count(*) from public.orders where external_id = 'PED-F41-ROLLBACK';
    `);
    expect(erro).toBe("23514");
    expect(chave).toBe("0");
    expect(pedido).toBe("0");
  });

  it("chave vazia (sem header) NÃO cria linha de idempotência", () => {
    sql(`
      select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-F41-SEM-CHAVE', 'BRL',
        '${LINHAS.replace(/'/g, "''")}'::jsonb, '${ACTOR}', 'user');
    `);
    const chaves = sql(`
      select count(*) from public.idempotency_keys
      where organization_id = '${ORG_A}' and endpoint = 'POST /api/v1/orders' and key = '';
    `);
    expect(chaves).toBe("0");
  });
});
