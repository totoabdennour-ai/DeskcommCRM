-- 0242 — REVENUE ACTIVATION FOUNDATION (RevenueOS, Fase 6 — docs/our-product/28)
--
-- O QUE: a camada derivada que transforma atividade existente em DINHEIRO
-- mensurável: `revenue_at_risk` (vazamento detectado, com linhagem) +
-- `revenue_events` (taxonomia de receita, dedup por fonte) + RPCs
-- (materialização determinística dos detectores + atribuição conservadora).
--
-- O QUE NÃO É: segundo modelo de oportunidade (`crm_leads` segue canônico —
-- doc 28 §2), Recovery Engine (F7 consome ESTA tabela), ou quadro de eventos
-- paralelo (o outbox 0241 e os triggers de lead seguem sendo os eventos
-- authoritative; `revenue_events` espelha o que a ativação precisa consultar).
--
-- REGRAS: detecção 100% SQL (IA nunca declara risco nem valor); idempotência
-- por identidade determinística (unique parcial em riscos abertos; unique
-- total em eventos por fonte); RLS select-only para authenticated (escrita só
-- via RPC/service_role — mesmo desenho de order_items, F4.1); delivery_failed
-- e confirmation_failed ficam FORA do CHECK v1 de propósito: não existe fonte
-- authoritativa (ERP F9 / sinal de confirmação F7) e inventar seria fabricar
-- dado (doc 29 §matriz).

create table if not exists public.revenue_at_risk (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  risk_type text not null check (risk_type in (
    'inquiry_without_response', 'stalled_opportunity', 'abandoned_draft_order',
    'no_price', 'dormant_customer', 'unresolved_open_state')),
  source_kind text not null check (source_kind in ('conversation', 'lead', 'order', 'account', 'product')),
  source_id uuid not null,
  account_id uuid references public.accounts(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  trigger_detail text not null,
  estimated_value_cents bigint check (estimated_value_cents is null or estimated_value_cents >= 0),
  currency bpchar(3),
  owner_user_id uuid references auth.users(id) on delete set null,
  deadline_at timestamptz,
  nba_action text not null,
  nba_reason text not null,
  status text not null default 'open' check (status in ('open', 'acted', 'resolved', 'expired', 'dismissed')),
  outcome_refs jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.revenue_at_risk is
  'Vazamento de receita DETECTADO por SQL determinístico (doc 28 §3). A linha é '
  || 'a Recovery Opportunity da F7. Valor vem SEMPRE de fonte determinística; '
  || 'IA lê, executa ações autorizadas e explica — nunca declara risco nem valor.';

-- Identidade de deduplicação: um risco aberto (ou já com ação) por
-- (org, tipo, fonte). Resolvido/expirado/removeu a trava — o mesmo tipo pode
-- reabrir legitimamente mais tarde (ex.: cliente dormente que volta e dorme de novo).
create unique index if not exists revenue_at_risk_aberto_identity
  on public.revenue_at_risk (organization_id, risk_type, source_kind, source_id)
  where status in ('open', 'acted');

create index if not exists revenue_at_risk_org_status_idx
  on public.revenue_at_risk (organization_id, status);
create index if not exists revenue_at_risk_account_idx
  on public.revenue_at_risk (account_id)
  where account_id is not null;

create table if not exists public.revenue_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_kind text not null check (event_kind in (
    'opportunity_created', 'opportunity_progressed',
    'order_created', 'order_confirmed', 'order_cancelled',
    'revenue_at_risk',
    'recovery_started', 'recovery_succeeded', 'recovery_failed',
    'revenue_influenced')),
  lineage text not null check (lineage in ('authoritative', 'derived')),
  source_kind text not null,
  source_id uuid not null,
  account_id uuid references public.accounts(id) on delete set null,
  lead_id uuid references public.crm_leads(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  risk_id uuid references public.revenue_at_risk(id) on delete set null,
  action_chain jsonb not null default '{}'::jsonb,
  value_cents bigint check (value_cents is null or value_cents >= 0),
  currency bpchar(3),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.revenue_events is
  'Taxonomia de receita (doc 28 §5). Authoritative = espelho do fato de negócio '
  || '(pedido/oportunidade). Derived = julgamento determinístico da ativação '
  || '(risco, atribuição). Dedup por (org, kind, source_kind, source_id) — '
  || 'reprocessar detector/atribuição NÃO duplica evento.';

create unique index if not exists revenue_events_identity
  on public.revenue_events (organization_id, event_kind, source_kind, source_id);

create index if not exists revenue_events_org_occurred_idx
  on public.revenue_events (organization_id, occurred_at);
create index if not exists revenue_events_account_idx
  on public.revenue_events (account_id)
  where account_id is not null;

alter table public.revenue_at_risk enable row level security;
alter table public.revenue_events enable row level security;

drop policy if exists revenue_at_risk_select on public.revenue_at_risk;
create policy revenue_at_risk_select on public.revenue_at_risk
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
-- Escrita: NENHUMA policy para authenticated — materialização só via RPC
-- (security definer) ou service_role. Mesmo desenho de order_items (F4).

drop policy if exists revenue_events_select on public.revenue_events;
create policy revenue_events_select on public.revenue_events
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- ── Guarda de acesso: RPC callable por service (cron) ou membro da org ─────
create or replace function public.fn_guarda_acesso_org(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return; -- service_role/cron: a borda Bearer já autenticou
  end if;
  if not exists (
    select 1 from public.user_organizations
    where user_id = auth.uid() and organization_id = p_org and revoked_at is null
  ) then
    raise exception 'chamador nao pertence a organizacao %', p_org
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.fn_guarda_acesso_org(uuid) from public, anon;
grant execute on function public.fn_guarda_acesso_org(uuid) to authenticated, service_role;

-- ── RPC: materializa UM risco (event-driven — a tool no_price chama) ───────
create or replace function public.fn_materializar_risco_unico(
  p_org uuid, p_type text, p_source_kind text, p_source_id uuid,
  p_account uuid, p_contact uuid, p_lead uuid, p_order uuid,
  p_trigger text, p_value bigint, p_moeda text,
  p_owner uuid, p_deadline timestamptz,
  p_nba text, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_existe uuid;
begin
  perform public.fn_guarda_acesso_org(p_org);

  select id into v_existe from public.revenue_at_risk
    where organization_id = p_org and risk_type = p_type
      and source_kind = p_source_kind and source_id = p_source_id
      and status in ('open', 'acted');

  insert into public.revenue_at_risk
    (organization_id, risk_type, source_kind, source_id,
     account_id, contact_id, lead_id, order_id,
     trigger_detail, estimated_value_cents, currency, owner_user_id, deadline_at,
     nba_action, nba_reason)
  values
    (p_org, p_type, p_source_kind, p_source_id,
     p_account, p_contact, p_lead, p_order,
     p_trigger, p_value, p_moeda, p_owner, p_deadline,
     p_nba, p_reason)
  on conflict (organization_id, risk_type, source_kind, source_id) do nothing
  where revenue_at_risk.status in ('open', 'acted')
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('risk_id', v_existe, 'materializado', false);
  end if;

  -- F6.1: source_id do evento = risk_id (o EPISÓDIO), não a fonte do risco —
  -- quando o mesmo (tipo, fonte) reabre depois de resolvido, o novo episódio
  -- tem identidade própria e NÃO colide com o evento do episódio anterior
  -- (o unique total por fonte quebraria a re-detecção com 23505 → 500 na
  -- tool do agente). A linhagem da FONTE continua nas colunas account/lead/
  -- order e no risk_id.
  insert into public.revenue_events
    (organization_id, event_kind, lineage, source_kind, source_id,
     account_id, lead_id, order_id, risk_id, action_chain, value_cents, currency, occurred_at)
  values
    (p_org, 'revenue_at_risk', 'derived', 'risk', v_id,
     p_account, p_lead, p_order, v_id,
     jsonb_build_object('trigger', p_trigger, 'risk_type', p_type,
                        'source_kind', p_source_kind, 'source_id', p_source_id),
     p_value, p_moeda, now())
  on conflict (organization_id, event_kind, source_kind, source_id) do nothing;

  return jsonb_build_object('risk_id', v_id, 'materializado', true);
end;
$$;

revoke execute on function public.fn_materializar_risco_unico(uuid, text, text, uuid, uuid, uuid, uuid, uuid, uuid, text, bigint, text, uuid, timestamptz, text, text)
  from public, anon;
grant execute on function public.fn_materializar_risco_unico(uuid, text, text, uuid, uuid, uuid, uuid, uuid, uuid, text, bigint, text, uuid, timestamptz, text, text)
  to authenticated, service_role;

-- ── RPC: materializa os detectores agendados (cron, service_role only) ─────
-- Seis detectores determinísticos (doc 28 §3): inquiry_without_response,
-- stalled_opportunity (PONTE sobre crm_lead_risk_states — sem duplicar),
-- abandoned_draft_order, dormant_customer, unresolved_open_state.
-- delivery_failed (aguarda ERP F9) e confirmation_failed (aguarda sinal
-- determinístico de confirmação, F7) ficam DEFERIDOS de propósito.
-- Idempotente: roda 2× e não duplica (unique parcial + where not exists).
create or replace function public.fn_materializar_riscos(p_org uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_linhas record;
  v_counts jsonb := '{}';
  v_n bigint;
begin
  if auth.uid() is not null then
    raise exception 'detectores rodam apenas via service_role (cron)'
      using errcode = '42501';
  end if;

  for v_org in
    select o.id from public.organizations o
    where (p_org is null or o.id = p_org) and o.status = 'active'
  loop
    -- ── D1 inquiry_without_response ──────────────────────────────────────
    with ultima as (
      select m.conversation_id,
             (array_agg(m.direction order by m.created_at desc))[1] as ultima_direcao,
             max(m.created_at) as ultima_em
      from public.messages m
      group by m.conversation_id
    )
    insert into public.revenue_at_risk
      (organization_id, risk_type, source_kind, source_id,
       account_id, contact_id, lead_id,
       trigger_detail, estimated_value_cents, currency, owner_user_id, deadline_at,
       nba_action, nba_reason)
    select
      c.organization_id, 'inquiry_without_response', 'conversation', c.id,
      ct.account_id, c.contact_id,
      (select l.id from public.crm_leads l
        where l.contact_id = c.contact_id and l.status = 'open'
        order by l.created_at desc limit 1),
      'ultima mensagem do cliente sem resposta ha ' ||
        greatest(0, floor(extract(epoch from (now() - u.ultima_em)) / 3600)) || 'h',
      (select l.value_cents from public.crm_leads l
        where l.contact_id = c.contact_id and l.status = 'open'
        order by l.created_at desc limit 1),
      (select l.currency from public.crm_leads l
        where l.contact_id = c.contact_id and l.status = 'open'
        order by l.created_at desc limit 1),
      (select l.owner_user_id from public.crm_leads l
        where l.contact_id = c.contact_id and l.status = 'open'
        order by l.created_at desc limit 1),
      u.ultima_em + interval '24 hours',
      'follow_up_customer',
      'Cliente falou e ficou sem resposta — responder e a acao de maior conversao.'
    from public.conversations c
    join ultima u on u.conversation_id = c.id
    join public.contacts ct on ct.id = c.contact_id
    where c.organization_id = v_org
      and u.ultima_direcao = 'inbound'
      and u.ultima_em < now() - interval '24 hours'
      and c.status in ('open', 'pending')
      and not exists (
        select 1 from public.revenue_at_risk r
        where r.organization_id = c.organization_id
          and r.risk_type = 'inquiry_without_response'
          and r.source_kind = 'conversation' and r.source_id = c.id
          and r.status in ('open', 'acted'));
    get diagnostics v_n = row_count;
    v_counts := jsonb_set(v_counts, '{inquiry_without_response}', to_jsonb(coalesce((v_counts->>'inquiry_without_response')::bigint, 0) + v_n));

    -- ── D2 stalled_opportunity — PONTE sobre crm_lead_risk_states ────────
    insert into public.revenue_at_risk
      (organization_id, risk_type, source_kind, source_id,
       account_id, contact_id, lead_id,
       trigger_detail, estimated_value_cents, currency, owner_user_id, deadline_at,
       nba_action, nba_reason)
    select
      l.organization_id, 'stalled_opportunity', 'lead', l.id,
      ct.account_id, l.contact_id, l.id,
      'oportunidade estagnada (' || rs.bucket || ') desde ' || to_char(rs.since, 'YYYY-MM-DD HH24:MI'),
      l.value_cents, l.currency, l.owner_user_id,
      now() + interval '7 days',
      'follow_up_customer',
      'Oportunidade com valor parou de evoluir — retomar com um angulo concreto.'
    from public.crm_lead_risk_states rs
    join public.crm_leads l on l.id = rs.lead_id
    left join public.contacts ct on ct.id = l.contact_id
    where l.organization_id = v_org
      and l.status = 'open'
      and rs.bucket in ('critico', 'em_risco')
      and not exists (
        select 1 from public.revenue_at_risk r
        where r.organization_id = l.organization_id
          and r.risk_type = 'stalled_opportunity'
          and r.source_kind = 'lead' and r.source_id = l.id
          and r.status in ('open', 'acted'));
    get diagnostics v_n = row_count;
    v_counts := jsonb_set(v_counts, '{stalled_opportunity}', to_jsonb(coalesce((v_counts->>'stalled_opportunity')::bigint, 0) + v_n));

    -- ── D3 abandoned_draft_order ─────────────────────────────────────────
    insert into public.revenue_at_risk
      (organization_id, risk_type, source_kind, source_id,
       account_id, contact_id, order_id,
       trigger_detail, estimated_value_cents, currency, owner_user_id, deadline_at,
       nba_action, nba_reason)
    select
      o.organization_id, 'abandoned_draft_order', 'order', o.id,
      o.account_id, o.contact_id, o.id,
      'rascunho sem confirmacao ha ' ||
        greatest(0, floor(extract(epoch from (now() - o.created_at)) / 3600)) || 'h',
      o.total_cents, o.currency,
      (select a.owner_user_id from public.accounts a where a.id = o.account_id),
      o.created_at + interval '24 hours',
      'request_confirmation',
      'Pedido montado e abandonado — retomar o rascunho com o cliente.'
    from public.orders o
    where o.organization_id = v_org
      and o.origin = 'manual'
      and o.status = 'draft'
      and o.created_at < now() - interval '24 hours'
      and not exists (
        select 1 from public.revenue_at_risk r
        where r.organization_id = o.organization_id
          and r.risk_type = 'abandoned_draft_order'
          and r.source_kind = 'order' and r.source_id = o.id
          and r.status in ('open', 'acted'));
    get diagnostics v_n = row_count;
    v_counts := jsonb_set(v_counts, '{abandoned_draft_order}', to_jsonb(coalesce((v_counts->>'abandoned_draft_order')::bigint, 0) + v_n));

    -- ── D4 dormant_customer ──────────────────────────────────────────────
    insert into public.revenue_at_risk
      (organization_id, risk_type, source_kind, source_id,
       account_id, contact_id,
       trigger_detail, estimated_value_cents, currency, owner_user_id, deadline_at,
       nba_action, nba_reason)
    select
      a.organization_id, 'dormant_customer', 'account', a.id,
      a.id, null,
      'cliente com historico sem novo pedido ha ' ||
        greatest(0, floor(extract(epoch from (now() - u.ultimo_pedido)) / 86400)) || ' dias',
      u.media_cents, (select currency from public.orders where account_id = a.id and status in ('confirmed','fulfilled','delivered','closed') order by ordered_at desc limit 1),
      a.owner_user_id,
      now() + interval '30 days',
      'reactivate_customer',
      'Cliente recorrente esfriou — win-back com a media do ticket dele.'
    from public.accounts a
    join (
      select o.account_id,
             max(o.ordered_at) as ultimo_pedido,
             (select round(avg(o2.total_cents)) from public.orders o2
               where o2.account_id = o.account_id
                 and o2.status in ('confirmed','fulfilled','delivered','closed')) as media_cents
      from public.orders o
      where o.organization_id = v_org
        and o.status in ('confirmed','fulfilled','delivered','closed')
      group by o.account_id
    ) u on u.account_id = a.id
    where a.organization_id = v_org
      and a.status = 'active'
      and u.ultimo_pedido < now() - interval '90 days'
      and not exists (
        select 1 from public.revenue_at_risk r
        where r.organization_id = a.organization_id
          and r.risk_type = 'dormant_customer'
          and r.source_kind = 'account' and r.source_id = a.id
          and r.status in ('open', 'acted'));
    get diagnostics v_n = row_count;
    v_counts := jsonb_set(v_counts, '{dormant_customer}', to_jsonb(coalesce((v_counts->>'dormant_customer')::bigint, 0) + v_n));

    -- ── D5 unresolved_open_state ─────────────────────────────────────────
    insert into public.revenue_at_risk
      (organization_id, risk_type, source_kind, source_id,
       account_id, contact_id, lead_id,
       trigger_detail, estimated_value_cents, currency, owner_user_id, deadline_at,
       nba_action, nba_reason)
    select
      l.organization_id, 'unresolved_open_state', 'lead', l.id,
      ct.account_id, l.contact_id, l.id,
      'oportunidade aberta sem proxima acao ha ' ||
        greatest(0, floor(extract(epoch from (now() - coalesce(l.last_activity_at, l.created_at))) / 86400)) || ' dias',
      l.value_cents, l.currency, l.owner_user_id,
      now() + interval '7 days',
      'follow_up_customer',
      'Oportunidade aberta sem proximo passo definido — definir e executar.'
    from public.crm_leads l
    left join public.contacts ct on ct.id = l.contact_id
    where l.organization_id = v_org
      and l.status = 'open'
      and coalesce(l.last_activity_at, l.created_at) < now() - interval '7 days'
      and not exists (
        select 1 from public.lead_checkpoints lc
        where lc.contact_id = l.contact_id
          and coalesce(lc.next_action, '') <> ''
          and lc.created_at > coalesce(l.last_activity_at, l.created_at) - interval '1 day')
      and not exists (
        select 1 from public.followup_enrollments fe
        where fe.contact_id = l.contact_id and fe.status in ('active', 'waiting_reply'))
      and not exists (
        select 1 from public.revenue_at_risk r
        where r.organization_id = l.organization_id
          and r.risk_type = 'unresolved_open_state'
          and r.source_kind = 'lead' and r.source_id = l.id
          and r.status in ('open', 'acted'));
    get diagnostics v_n = row_count;
    v_counts := jsonb_set(v_counts, '{unresolved_open_state}', to_jsonb(coalesce((v_counts->>'unresolved_open_state')::bigint, 0) + v_n));
  end loop;

  return v_counts;
end;
$$;

revoke execute on function public.fn_materializar_riscos(uuid)
  from public, anon, authenticated;
grant execute on function public.fn_materializar_riscos(uuid)
  to service_role;

-- ── RPC: atribuição conservadora (DIRECT/RECOVERED/INFLUENCED) ─────────────
-- Chamada na confirmação do pedido (rota) e no backfill do cron. Idempotente:
-- dedup por (org, kind, fonte). Cadeia completa nos action_chain.
create or replace function public.fn_atribuir_receita(p_org uuid, p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pedido record;
  v_risco record;
  v_recuperados bigint := 0;
  v_influenciado boolean := false;
  v_janela_dias int := 30;
begin
  perform public.fn_guarda_acesso_org(p_org);

  select * into v_pedido from public.orders
    where id = p_order and organization_id = p_org;
  if v_pedido.id is null then
    raise exception 'pedido % nao encontrado na organizacao %', p_order, p_org
      using errcode = '23514';
  end if;
  if v_pedido.status not in ('confirmed', 'fulfilled', 'delivered', 'closed') then
    raise exception 'atribuicao exige pedido confirmado (status %)', v_pedido.status
      using errcode = '23514';
  end if;

  -- DIRECT (authoritative: espelho do fato para a consulta de receita)
  insert into public.revenue_events
    (organization_id, event_kind, lineage, source_kind, source_id,
     account_id, contact_id, order_id, value_cents, currency, occurred_at)
  values
    (p_org, 'order_confirmed', 'authoritative', 'order', v_pedido.id,
     v_pedido.account_id, v_pedido.contact_id, v_pedido.id,
     v_pedido.total_cents, v_pedido.currency, coalesce(v_pedido.ordered_at, now()))
  on conflict (organization_id, event_kind, source_kind, source_id) do nothing;

  -- order_created (espelho idempotente — o outbox 0241 continua sendo a fonte)
  insert into public.revenue_events
    (organization_id, event_kind, lineage, source_kind, source_id,
     account_id, contact_id, order_id, value_cents, currency, occurred_at)
  values
    (p_org, 'order_created', 'authoritative', 'order', v_pedido.id,
     v_pedido.account_id, v_pedido.contact_id, v_pedido.id,
     v_pedido.total_cents, v_pedido.currency, v_pedido.created_at)
  on conflict (organization_id, event_kind, source_kind, source_id) do nothing;

  -- opportunity_created (espelho das oportunidades da conta)
  insert into public.revenue_events
    (organization_id, event_kind, lineage, source_kind, source_id,
     account_id, lead_id, order_id, value_cents, currency, occurred_at)
  select
    p_org, 'opportunity_created', 'authoritative', 'lead', l.id,
    ct.account_id, l.id, p_order, l.value_cents, l.currency,
    l.created_at
  from public.crm_leads l
  left join public.contacts ct on ct.id = l.contact_id
  where l.organization_id = p_org
    and l.contact_id in (select contact_id from public.orders where id = p_order)
  on conflict (organization_id, event_kind, source_kind, source_id) do nothing;

  -- RECOVERED (F6.1): exige os TRÊS elementos do doc 28 — risco persistido
  -- detectado antes do pedido + AÇÃO QUALIFICANTE RASTREADA ENTRE a detecção
  -- e o pedido (atividade do lead/contato, follow-up iniciado, ou risco
  -- 'acted') + pedido confirmado. Sem a ação do meio, o risco resolve como
  -- 'resolved' com tipo 'direct_only' — SEM recovery_succeeded (a receita
  -- permanece DIRECT: atribuição conservadora, sem falso positivo).
  for v_risco in
    select * from public.revenue_at_risk
    where organization_id = p_org
      and status in ('open', 'acted')
      and (order_id = p_order
           or (account_id = v_pedido.account_id
               and detected_at <= coalesce(v_pedido.ordered_at, now())))
  loop
    declare
      v_qualificou boolean := v_risco.status = 'acted';
    begin
      if not v_qualificou then
        select exists (
          select 1 from public.crm_lead_activities a
          where a.created_at > v_risco.detected_at
            and a.created_at < coalesce(v_pedido.ordered_at, now())
            and a.lead_id in (
              select id from public.crm_leads
              where organization_id = p_org
                and (id = v_risco.lead_id
                     or contact_id = v_risco.contact_id))
        ) or exists (
          select 1 from public.followup_enrollments fe
          where fe.contact_id = v_risco.contact_id
            and fe.started_at > v_risco.detected_at
            and fe.started_at < coalesce(v_pedido.ordered_at, now())
        ) into v_qualificou;
      end if;

      update public.revenue_at_risk
        set status = 'resolved',
            outcome_refs = jsonb_build_object(
              'order_id', p_order,
              'tipo', case when v_qualificou then 'recovered' else 'direct_only' end),
            updated_at = now()
        where id = v_risco.id;

      if v_qualificou then
        insert into public.revenue_events
          (organization_id, event_kind, lineage, source_kind, source_id,
           account_id, lead_id, order_id, risk_id, action_chain,
           value_cents, currency, occurred_at)
        values
          (p_org, 'recovery_succeeded', 'derived', 'risk', v_risco.id,
           v_risco.account_id, v_risco.lead_id, p_order, v_risco.id,
           jsonb_build_object('risk_type', v_risco.risk_type, 'order_id', p_order),
           coalesce(v_risco.estimated_value_cents, v_pedido.total_cents), v_risco.currency, now())
        on conflict (organization_id, event_kind, source_kind, source_id) do nothing;

        v_recuperados := v_recuperados + 1;
      end if;
    end;
  end loop;

  -- INFLUENCED (F6.1): SEM recovery, mas ação rastreada do RevenueOS
  -- ANTERIOR AO PEDIDO dentro da janela. ⚠️ O espelho order_created inserido
  -- acima NÃO qualifica (é o próprio pedido, não uma ação que o precedeu) —
  -- o predicado compara ACTION_TIMESTAMP < ORDER_TIMESTAMP, nunca now().
  if v_recuperados = 0 then
    if exists (
      select 1 from public.crm_lead_activities a
      where a.lead_id in (
          select id from public.crm_leads
          where organization_id = p_org
            and contact_id in (select contact_id from public.orders where id = p_order))
        and a.created_at < coalesce(v_pedido.ordered_at, now())
        and a.created_at >= coalesce(v_pedido.ordered_at, now()) - (v_janela_dias || ' days')::interval
    ) then
      insert into public.revenue_events
        (organization_id, event_kind, lineage, source_kind, source_id,
         account_id, contact_id, order_id, action_chain, value_cents, currency, occurred_at)
      values
        (p_org, 'revenue_influenced', 'derived', 'order', v_pedido.id,
         v_pedido.account_id, v_pedido.contact_id, v_pedido.id,
         jsonb_build_object('janela_dias', v_janela_dias,
           'acao', 'atividade rastreada do RevenueOS precedeu o pedido'),
         v_pedido.total_cents, v_pedido.currency, now())
      on conflict (organization_id, event_kind, source_kind, source_id) do nothing;
      v_influenciado := true;
    end if;
  end if;

  return jsonb_build_object('recuperados', v_recuperados, 'influenciado', v_influenciado);
end;
$$;

revoke execute on function public.fn_atribuir_receita(uuid, uuid)
  from public, anon;
grant execute on function public.fn_atribuir_receita(uuid, uuid)
  to authenticated, service_role;

drop trigger if exists trg_revenue_at_risk_updated_at on public.revenue_at_risk;
create trigger trg_revenue_at_risk_updated_at
  before update on public.revenue_at_risk
  for each row execute function public.fn_set_updated_at();
