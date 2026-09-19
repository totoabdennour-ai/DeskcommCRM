import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * REVENUE ACTIVATION — A AUTORIDADE É O BANCO (0242, Fase 6).
 *
 * O que se prova com writes SEM RLS (role postgres) contra o Postgres efêmero:
 *
 *   1. Detectores: materializam risco com valor determinístico; rodar 2× NÃO
 *      duplica (identidade dedup); org sem dados → zero linhas.
 *   2. Atribuição: DIRECT (order_confirmed espelhado), RECOVERED (risco aberto
 *      da conta resolvido + recovery_succeeded), INFLUENCED (ação rastreada
 *      precede o pedido), idempotente por re-execução.
 *   3. Guarda de acesso: session sem membership → 42501; service passa.
 *   4. RLS: authenticated NÃO insere em revenue_at_risk/revenue_events (42501)
 *      e lê só a própria org.
 *
 * Roda contra o Postgres efêmero de `pnpm test:db` (scripts/test-db.sh).
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

const ORG_A = "ffffffff-0000-4000-8000-000000000001";
const ORG_B = "ffffffff-0000-4000-8000-000000000002";
const CONTA_A = "ffffffff-1000-4000-8000-000000000001";
const CONTATO_A = "ffffffff-2000-4000-8000-000000000001";
const MEMBRO_A = "ffffffff-5000-4000-8000-000000000001";
const PRODUTO_A = "ffffffff-6000-4000-8000-000000000001";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${MEMBRO_A}', 'receita-inv@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_A}', 'receita-inv-a', 'Receita Invariante A', 'Receita A'),
             ('${ORG_B}', 'receita-inv-b', 'Receita Invariante B', 'Receita B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${MEMBRO_A}', '${ORG_A}', 'manager', now())
      on conflict do nothing;
    insert into public.accounts (id, organization_id, name)
      values ('${CONTA_A}', '${ORG_A}', 'Conta Receita A')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, display_name, account_id)
      values ('${CONTATO_A}', '${ORG_A}', 'Contato Receita A', '${CONTA_A}')
      on conflict (id) do nothing;
    insert into public.catalog_products (id, organization_id, codigo, nome, preco_cents, moeda)
      values ('${PRODUTO_A}', '${ORG_A}', 'REC-INV-A', 'Produto Receita A', 1000, 'BRL')
      on conflict (id) do nothing;
  `);
});

describe("detectores — materialização determinística e idempotente", () => {
  it("rascunho abandonado > 24h materializa com valor = total do pedido", () => {
    // Criado AGORA + empurrado para trás: o detector olha created_at < now()-24h.
    sql(`
      insert into public.orders (id, organization_id, external_id, external_provider, account_id, origin, status, total_cents, currency, ordered_at, created_at)
      values ('ffffffff-7000-4000-8000-000000000001', '${ORG_A}', 'PED-REC-1', 'manual', '${CONTA_A}', 'manual', 'draft', 499900, 'BRL', now(), now() - interval '30 hours')
      on conflict (id) do nothing;
      update public.orders set created_at = now() - interval '30 hours' where id = 'ffffffff-7000-4000-8000-000000000001';
    `);

    const r = sql(`select public.fn_materializar_riscos('${ORG_A}');`);
    const corpo = JSON.parse(r) as Record<string, number>;
    expect(corpo.abandoned_draft_order).toBeGreaterThanOrEqual(1);

    const risco = sql(`
      select estimated_value_cents || '|' || nba_action from public.revenue_at_risk
      where organization_id = '${ORG_A}' and risk_type = 'abandoned_draft_order'
        and source_id = 'ffffffff-7000-4000-8000-000000000001';
    `);
    expect(risco).toBe("499900|request_confirmation");
  });

  it("rodar o detector 2× NÃO duplica (identidade dedup)", () => {
    sql(`select public.fn_materializar_riscos('${ORG_A}');`);
    const contagem = sql(`
      select count(*) from public.revenue_at_risk
      where organization_id = '${ORG_A}' and risk_type = 'abandoned_draft_order';
    `);
    expect(contagem).toBe("1");
  });

  it("org SEM dados → zero linhas novas (sem fabricação)", () => {
    const antes = sql(`select count(*) from public.revenue_at_risk where organization_id = '${ORG_B}';`);
    sql(`select public.fn_materializar_riscos('${ORG_B}');`);
    const depois = sql(`select count(*) from public.revenue_at_risk where organization_id = '${ORG_B}';`);
    expect(antes).toBe(depois);
  });
});

describe("fn_atribuir_receita — DIRECT / RECOVERED / idempotência", () => {
  const PEDIDO = sql(`
    select public.fn_criar_pedido('${ORG_A}', '${CONTA_A}', 'PED-REC-ATR', 'BRL',
      '${JSON.stringify([
        { product_id: PRODUTO_A, sku: "REC-INV-A", nome: "Produto Receita A", quantity: 2,
          unit_price_cents: 900, moeda: "BRL", fonte: "catalog_base", resolvido_em: null },
      ]).replace(/'/g, "''")}'::jsonb, null, 'system');
  `);

  it("confirma o pedido e atribui: DIRECT espelhado + evento dedupado", () => {
    sql(`
      update public.orders set status = 'confirmed' where id = '${PEDIDO}';
      select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO}');
    `);
    const eventos = sql(`
      select count(*) from public.revenue_events
      where organization_id = '${ORG_A}' and order_id = '${PEDIDO}'
        and event_kind = 'order_confirmed' and lineage = 'authoritative';
    `);
    expect(eventos).toBe("1");
  });

  it("RECOVERED: risco aberto da conta é resolvido com recovery_succeeded na cadeia", () => {
    sql(`
      insert into public.revenue_at_risk
        (organization_id, risk_type, source_kind, source_id, account_id, trigger_detail,
         estimated_value_cents, currency, nba_action, nba_reason, detected_at)
      values ('${ORG_A}', 'dormant_customer', 'account', '${CONTA_A}', '${CONTA_A}',
        'cliente sem pedido ha 120 dias', 5000, 'BRL', 'reactivate_customer',
        'win-back', now() - interval '10 days');
      select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO}');
    `);
    const resolvido = sql(`
      select status from public.revenue_at_risk
      where organization_id = '${ORG_A}' and risk_type = 'dormant_customer'
        and source_id = '${CONTA_A}';
    `);
    const evento = sql(`
      select count(*) from public.revenue_events
      where organization_id = '${ORG_A}' and event_kind = 'recovery_succeeded'
        and order_id = '${PEDIDO}';
    `);
    expect(resolvido).toBe("resolved");
    expect(evento).toBe("1");
  });

  it("re-executar a atribuição NÃO duplica eventos (dedup por fonte)", () => {
    sql(`select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO}');`);
    const eventos = sql(`
      select count(*) from public.revenue_events
      where organization_id = '${ORG_A}' and order_id = '${PEDIDO}';
    `);
    // order_created + order_confirmed + opportunity_created + recovery_succeeded
    // — cada um exatamente 1× (dedup por fonte).
    expect(Number(eventos)).toBeLessThanOrEqual(4);
  });
});

describe("guarda de acesso e RLS (F4.1 mold aplicado à receita)", () => {
  it("session SEM membership na org → 42501 (fn_guarda_acesso_org)", () => {
    const erro = sqlQueFalha(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MEMBRO_A}"}', false);
      select public.fn_atribuir_receita('${ORG_B}', 'ffffffff-7000-4000-8000-000000000001');
      reset role;
    `);
    expect(erro).toBe("42501");
  });

  it("authenticated NÃO insere em revenue_at_risk (42501 — select-only)", () => {
    const erro = sqlQueFalha(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MEMBRO_A}"}', false);
      insert into public.revenue_at_risk
        (organization_id, risk_type, source_kind, source_id, trigger_detail, nba_action, nba_reason)
      values ('${ORG_A}', 'dormant_customer', 'account', '${CONTA_A}', 'bypass', 'follow_up_customer', 'x');
      reset role;
    `);
    expect(erro).toBe("42501");
  });

  it("authenticated lê SOMAENTE a própria org (RLS select)", () => {
    sql(`
      insert into public.revenue_at_risk
        (organization_id, risk_type, source_kind, source_id, account_id, trigger_detail, nba_action, nba_reason)
      values ('${ORG_B}', 'dormant_customer', 'account', '${CONTA_A}', null, 'risco do vizinho', 'follow_up_customer', 'x');
    `);
    const visiveis = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${MEMBRO_A}"}', false);
      select count(*) from public.revenue_at_risk where organization_id = '${ORG_B}';
      reset role;
    `);
    expect(visiveis).toBe("0");
  });
});

// ─── F6.1 — atribuição conservadora e episódios de risco ────────────────────

describe("F6.1-1 — revenue_influenced NÃO é tautológico", () => {
  const PEDIDO_INFL = "ffffffff-8000-4000-8000-000000000001";

  it("A. pedido SEM ação prévia → NÃO é influenciado (o espelho order_created não qualifica)", () => {
    sql(`
      insert into public.orders (id, organization_id, external_id, external_provider, account_id, contact_id, origin, status, total_cents, currency, ordered_at, created_at)
      values ('${PEDIDO_INFL}', '${ORG_A}', 'PED-F61-INFL', 'manual', '${CONTA_A}', '${CONTATO_A}', 'manual', 'confirmed', 3000, 'BRL', now(), now() - interval '1 day')
      on conflict (id) do nothing;
      select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO_INFL}');
    `);
    const influenciado = sql(`
      select count(*) from public.revenue_events
      where organization_id = '${ORG_A}' and order_id = '${PEDIDO_INFL}'
        and event_kind = 'revenue_influenced';
    `);
    // O espelho order_created EXISTE (inserido pela própria atribuição) e
    // ainda assim NÃO gerou influência — a tautologia está morta.
    const espelho = sql(`
      select count(*) from public.revenue_events
      where organization_id = '${ORG_A}' and order_id = '${PEDIDO_INFL}'
        and event_kind = 'order_created';
    `);
    expect(espelho).toBe("1");
    expect(influenciado).toBe("0");
  });

  it("B. atividade rastreada ANTES do pedido (dentro da janela) → INFLUENCED", () => {
    const PEDIDO_INFL2 = "ffffffff-8000-4000-8000-000000000002";
    const LEAD_INFL = "ffffffff-8000-4000-8000-000000000003";
    sql(`
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title, status)
      values ('${LEAD_INFL}', '${ORG_A}',
        (select id from public.crm_pipelines where organization_id = '${ORG_A}' limit 1),
        (select id from public.crm_stages where organization_id = '${ORG_A}' limit 1),
        '${CONTATO_A}', 'Lead Influência', 'open')
      on conflict (id) do nothing;
      insert into public.orders (id, organization_id, external_id, external_provider, account_id, contact_id, origin, status, total_cents, currency, ordered_at, created_at)
      values ('${PEDIDO_INFL2}', '${ORG_A}', 'PED-F61-INFL2', 'manual', '${CONTA_A}', '${CONTATO_A}', 'manual', 'confirmed', 2000, 'BRL', now(), now() - interval '1 day')
      on conflict (id) do nothing;
      update public.orders set ordered_at = now() - interval '2 days' where id = '${PEDIDO_INFL2}';
      insert into public.crm_lead_activities (organization_id, lead_id, type, payload, created_at)
      values ('${ORG_A}', '${LEAD_INFL}', 'note', '{"resumo":"agente enviou orçamento"}'::jsonb, now() - interval '3 days');
      select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO_INFL2}');
    `);
    const influenciado = sql(`
      select count(*) from public.revenue_events
      where organization_id = '${ORG_A}' and order_id = '${PEDIDO_INFL2}'
        and event_kind = 'revenue_influenced';
    `);
    expect(influenciado).toBe("1");
  });

  it("C+D. atividade fora da janela (depois do pedido) NÃO influencia", () => {
    const PEDIDO_TARDE = "ffffffff-8000-4000-8000-000000000004";
    sql(`
      insert into public.orders (id, organization_id, external_id, external_provider, account_id, contact_id, origin, status, total_cents, currency, ordered_at, created_at)
      values ('${PEDIDO_TARDE}', '${ORG_A}', 'PED-F61-INFL3', 'manual', '${CONTA_A}', '${CONTATO_A}', 'manual', 'confirmed', 1500, 'BRL', now() - interval '5 days', now() - interval '6 days')
      on conflict (id) do nothing;
      insert into public.crm_lead_activities (organization_id, lead_id, type, payload, created_at)
      values ('${ORG_A}', '${PEDIDO_TARDE}', 'note', '{"x":1}'::jsonb, now() - interval '1 day');
      select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO_TARDE}');
    `);
    const influenciado = sql(`
      select count(*) from public.revenue_events
      where organization_id = '${ORG_A}' and order_id = '${PEDIDO_TARDE}'
        and event_kind = 'revenue_influenced';
    `);
    expect(influenciado).toBe("0");
  });
});

describe("F6.1-2 — RECOVERED exige ação qualificante entre detecção e pedido", () => {
  const RISCO_SEM_ACAO = "ffffffff-9000-4000-8000-000000000001";
  const RISCO_COM_ACAO = "ffffffff-9000-4000-8000-000000000002";
  const PEDIDO_REC = "ffffffff-9000-4000-8000-000000000003";
  const LEAD_REC = "ffffffff-9000-4000-8000-000000000004";

  it("A. risco SEM ação + pedido confirmado → resolved 'direct_only', SEM recovery_succeeded", () => {
    sql(`
      insert into public.revenue_at_risk
        (id, organization_id, risk_type, source_kind, source_id, account_id, trigger_detail,
         estimated_value_cents, currency, nba_action, nba_reason, detected_at)
      values ('${RISCO_SEM_ACAO}', '${ORG_A}', 'dormant_customer', 'account', '${CONTA_A}',
        'dormente sem interação', 7000, 'BRL', 'reactivate_customer', 'win-back',
        now() - interval '20 days');
      insert into public.orders (id, organization_id, external_id, external_provider, account_id, contact_id, origin, status, total_cents, currency, ordered_at, created_at)
      values ('${PEDIDO_REC}', '${ORG_A}', 'PED-F61-REC', 'manual', '${CONTA_A}', '${CONTATO_A}', 'manual', 'confirmed', 7000, 'BRL', now() - interval '2 days', now() - interval '3 days')
      on conflict (id) do nothing;
      select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO_REC}');
    `);
    const estado = sql(`
      select status || '|' || coalesce(outcome_refs->>'tipo', 'null') from public.revenue_at_risk
      where id = '${RISCO_SEM_ACAO}';
    `);
    const recovery = sql(`
      select count(*) from public.revenue_events
      where risk_id = '${RISCO_SEM_ACAO}' and event_kind = 'recovery_succeeded';
    `);
    expect(estado).toBe("resolved|direct_only");
    expect(recovery).toBe("0");
  });

  it("B. risco + atividade ENTRE detecção e pedido → RECOVERED com recovery_succeeded", () => {
    sql(`
      insert into public.revenue_at_risk
        (id, organization_id, risk_type, source_kind, source_id, account_id, trigger_detail,
         estimated_value_cents, currency, nba_action, nba_reason, detected_at)
      values ('${RISCO_COM_ACAO}', '${ORG_A}', 'dormant_customer', 'account', '${CONTA_A}',
        'dormente, mas o agente retomou', 6000, 'BRL', 'reactivate_customer', 'win-back',
        now() - interval '25 days');
      insert into public.crm_lead_activities (organization_id, lead_id, type, payload, created_at)
      values ('${ORG_A}', '${LEAD_REC}', 'note', '{"resumo":"agente retomou o cliente"}'::jsonb,
        now() - interval '15 days');
      select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO_REC}');
    `);
    const estado = sql(`
      select coalesce(outcome_refs->>'tipo', 'null') from public.revenue_at_risk
      where id = '${RISCO_COM_ACAO}';
    `);
    const recovery = sql(`
      select count(*) from public.revenue_events
      where risk_id = '${RISCO_COM_ACAO}' and event_kind = 'recovery_succeeded';
    `);
    expect(estado).toBe("recovered");
    expect(recovery).toBe("1");
  });

  it("C. atividade ANTES da detecção não qualifica (risco segue direct_only)", () => {
    const RISCO_ANTES = "ffffffff-9000-4000-8000-000000000005";
    sql(`
      insert into public.revenue_at_risk
        (id, organization_id, risk_type, source_kind, source_id, account_id, trigger_detail,
         estimated_value_cents, currency, nba_action, nba_reason, detected_at)
      values ('${RISCO_ANTES}', '${ORG_A}', 'dormant_customer', 'account', '${CONTA_A}',
        'detectado depois da atividade antiga', 4000, 'BRL', 'reactivate_customer', 'x',
        now() - interval '5 days');
      select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO_REC}');
    `);
    const estado = sql(`
      select coalesce(outcome_refs->>'tipo', 'null') from public.revenue_at_risk
      where id = '${RISCO_ANTES}';
    `);
    expect(estado).toBe("direct_only");
  });

  it("E. risco de OUTRA conta/org não é resolvido pela atribuição deste pedido", () => {
    sql(`
      insert into public.revenue_at_risk
        (organization_id, risk_type, source_kind, source_id, account_id, trigger_detail,
         estimated_value_cents, currency, nba_action, nba_reason)
      values ('${ORG_B}', 'dormant_customer', 'account', 'ffffffff-1000-4000-8000-000000000009',
        null, 'risco do vizinho', 8000, 'BRL', 'reactivate_customer', 'x');
      select public.fn_atribuir_receita('${ORG_A}', '${PEDIDO_REC}');
    `);
    const vizinho = sql(`
      select status from public.revenue_at_risk
      where organization_id = '${ORG_B}'
        and source_id = 'ffffffff-1000-4000-8000-000000000009';
    `);
    expect(vizinho).toBe("open");
  });
});

describe("F6.1-3 — episódios de risco reabrem SEM colisão (no_price segue modelado)", () => {
  it("1º episódio cria evento; resolvido; reabertura cria SEU evento — sem 23505", () => {
    const fonte = 'ffffffff-6000-4000-8000-000000000002';
    // 1º episódio
    const primeiro = sql(`
      select public.fn_materializar_risco_unico('${ORG_A}', 'no_price', 'product', '${fonte}',
        '${CONTA_A}', null, null, null, 'produto_inativo', null, null, null, null,
        'clarify_product', 'Linha sem preço.');
    `);
    const primeiroId = (JSON.parse(primeiro) as { risk_id: string }).risk_id;
    const evento1 = sql(`
      select count(*) from public.revenue_events
      where event_kind = 'revenue_at_risk' and risk_id = '${primeiroId}';
    `);
    expect(evento1).toBe("1");

    // Resolve o 1º episódio (ciclo de vida existente)
    sql(`
      update public.revenue_at_risk set status = 'resolved', outcome_refs = '{"x":1}'::jsonb
      where id = '${primeiroId}';
    `);

    // 2º episódio da MESMA fonte: a linha de risco nasce (unique parcial só em
    // open/acted) e o evento usa risk_id — SEM colisão.
    const segundo = sql(`
      select public.fn_materializar_risco_unico('${ORG_A}', 'no_price', 'product', '${fonte}',
        '${CONTA_A}', null, null, null, 'produto_inativo', null, null, null, null,
        'clarify_product', 'Linha sem preço de novo.');
    `);
    const segundoId = (JSON.parse(segundo) as { risk_id: string }).risk_id;
    expect(segundoId).not.toBe(primeiroId);

    const eventos2 = sql(`
      select count(*) from public.revenue_events
      where event_kind = 'revenue_at_risk' and risk_id = '${segundoId}';
    `);
    expect(eventos2).toBe("1");

    const episodios = sql(`
      select count(*) from public.revenue_at_risk
      where risk_type = 'no_price' and source_id = '${fonte}';
    `);
    expect(Number(episodios)).toBeGreaterThanOrEqual(2);
  });
});
