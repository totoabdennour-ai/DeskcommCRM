-- 0241 — ORDER ENGINE: pedido nativo, itens, eventos (RevenueOS, Fase 4)
--
-- O QUE: `orders` deixa de ser só espelho externo (D3) e ganha ORIGEM +
-- CONTA + ciclo de vida nativo (draft→confirmed→…), com LINHAS
-- (`order_items`, snapshot imutável do preço — A6) e LOG DE DOMÍNIO
-- (`order_events`, append-only). Decisões A1–A6/B1–B3: docs/our-product/25.
--
-- INVARIANTES de nascimento (doc 14):
--  - pedido NATIVO exige conta (CHECK origin<> 'manual' OR account_id NOT NULL — B7);
--  - transições validadas nas RPCs (mesma transação do evento);
--  - total = Σ(linha × quantidade) — DIRC: calculado, nunca duplicado;
--  - item sem produto (produto removido) SOBREVIVE com snapshot (SET NULL):
--    pedido histórico não desaparece com o catálogo.
--
-- OUTBOX: as RPCs (abaixo) inserem order_events E event_log NA MESMA
-- transação da mutação — trigger nunca faz HTTP; consumidor assíncrono é
-- opt-in via event_log (doc 07 §6).

-- ── 1. orders: origem, conta e ciclo de vida ────────────────────────────────

alter table public.orders
  add column if not exists origin text not null default 'manual';
alter table public.orders
  add column if not exists account_id uuid references public.accounts(id) on delete set null;

-- Pedidos nativos (origin='manual') EXIGEM conta (B7). Espelhos externos não.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'orders_native_tem_conta'
       and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_native_tem_conta
      check (origin <> 'manual' or account_id is not null);
  end if;
end $$;

-- Backfill honesto: linhas de espelho pré-existentes carregam a origem do
-- próprio provider (nenhum escritor de orders existe no repo inteiro, então
-- isto é belt-and-suspenders para clones com dados hipotéticos).
update public.orders set origin = external_provider
where origin = 'manual' and external_provider <> 'manual';

-- external_provider ganha 'manual' (pedido nativo não tem provider externo).
alter table public.orders drop constraint if exists orders_external_provider_check;
alter table public.orders
  add constraint orders_external_provider_check
  check (external_provider = ANY (ARRAY['manual'::text, 'nuvemshop'::text, 'vtex'::text, 'shopify'::text]));

-- status ganha o ciclo de vida nativo (mantém os valores do espelho).
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add constraint orders_status_check
  check (status = ANY (ARRAY['draft'::text, 'confirmed'::text, 'pending'::text, 'paid'::text,
                             'cancelled'::text, 'fulfilled'::text, 'shipped'::text,
                             'delivered'::text, 'closed'::text, 'refunded'::text]));

create index if not exists orders_org_origin_idx
  on public.orders (organization_id, origin);
create index if not exists orders_org_account_idx
  on public.orders (organization_id, account_id)
  where account_id is not null;

-- ── F4.1-1: `orders` vira SELECT-ONLY para authenticated ───────────────────
--
-- A policy `orders_tenant_write` era da era-espelho (ninguém escrevia) e dava
-- write org-flat a QUALQUER papel. Com o engine ativo, `orders` é DINHEIRO com
-- máquina de estados: mutação direta pelo PostgREST pularia order_events,
-- event_log e as validações das RPCs — pedido "confirmado" fantasma, sem
-- trilha. A partir daqui, escrita SÓ pelas RPCs (security definer) ou
-- service_role (o futuro escritor de espelho da F9). A policy de SELECT
-- (`orders_tenant_select`) segue intacta para a leitura de operação.
drop policy if exists orders_tenant_write on public.orders;

-- Conta do pedido: mesma organização (a FK simples não enxerga tenant).
create or replace function public.fn_valida_conta_do_pedido()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.account_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.accounts
    where id = new.account_id and organization_id = new.organization_id
  ) then
    raise exception 'conta % nao pertence a organizacao %', new.account_id, new.organization_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_valida_conta_do_pedido() from public, anon;
grant execute on function public.fn_valida_conta_do_pedido() to authenticated, service_role;

drop trigger if exists trg_orders_valida_conta on public.orders;
create trigger trg_orders_valida_conta
  before insert or update of account_id on public.orders
  for each row execute function public.fn_valida_conta_do_pedido();

-- ── 2. order_items: as linhas com snapshot de preço (A6) ────────────────────

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.catalog_products(id) on delete set null,
  sku text not null,
  nome text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  moeda bpchar(3) not null,
  fonte text not null check (fonte in ('price_list', 'catalog_base')),
  price_list_id uuid,
  price_list_item_id uuid,
  resolvido_em timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.order_items is
  'Linhas do pedido com o preço CONGELADO no momento da confirmação (A6). '
  || 'Mudou o catálogo/lista? O pedido histórico não se move — snapshot é verdade. '
  || 'product_id vira NULL se o produto for removido do catálogo; o snapshot fica.';

create index if not exists order_items_order_idx on public.order_items (order_id);
create index if not exists order_items_product_idx
  on public.order_items (product_id) where product_id is not null;

alter table public.order_items enable row level security;

drop policy if exists order_items_select on public.order_items;
create policy order_items_select on public.order_items
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );
-- Escrita: NENHUMA policy para authenticated — linhas nascem só dentro das
-- RPCs do engine (security definer) ou via service_role. O cliente de sessão
-- lê; nunca grava linha diretamente.

-- Linha apontando para produto de outra org é recusada (quando product_id vem).
create or replace function public.fn_valida_produto_da_linha()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.product_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.catalog_products
    where id = new.product_id and organization_id = new.organization_id
  ) then
    raise exception 'produto % nao pertence a organizacao %', new.product_id, new.organization_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_valida_produto_da_linha() from public, anon;
grant execute on function public.fn_valida_produto_da_linha() to authenticated, service_role;

drop trigger if exists trg_order_items_valida_produto on public.order_items;
create trigger trg_order_items_valida_produto
  before insert or update of product_id on public.order_items
  for each row execute function public.fn_valida_produto_da_linha();

-- ── 3. order_events: o log de domínio, append-only ──────────────────────────

create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  seq bigint generated always as identity,
  kind text not null check (kind in ('created', 'edited', 'confirmed', 'cancelled')),
  payload jsonb not null default '{}'::jsonb,
  actor_kind text not null default 'system' check (actor_kind in ('user', 'ai', 'system')),
  actor_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.order_events is
  'Log de domínio do pedido (append-only — nada UPDATE/DELETE). Toda transição '
  || 'de estado nasce aqui NO MESMO COMMIT da mutação (outbox, doc 07 §6).';

create index if not exists order_events_order_idx on public.order_events (order_id, seq);

alter table public.order_events enable row level security;

drop policy if exists order_events_select on public.order_events;
create policy order_events_select on public.order_events
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- ── 4. RPCs do engine: mutação + evento NO MESMO COMMIT (outbox) ────────────

-- Evento de domínio + evento de barramento, na transação do chamador.
create or replace function public.fn_registra_evento_do_pedido(
  p_org uuid, p_order uuid, p_kind text, p_payload jsonb, p_actor_kind text, p_actor uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evento uuid;
begin
  insert into public.order_events (organization_id, order_id, kind, payload, actor_kind, actor_user_id)
    values (p_org, p_order, p_kind, p_payload, p_actor_kind, p_actor);

  v_evento := public.emit_event(
    'order.' || p_kind, 'order', p_order,
    jsonb_build_object('order_id', p_order, 'kind', p_kind, 'payload', p_payload),
    jsonb_build_object('actor_kind', p_actor_kind),
    p_org
  );
end;
$$;

revoke execute on function public.fn_registra_evento_do_pedido(uuid, uuid, text, jsonb, text, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_registra_evento_do_pedido(uuid, uuid, text, jsonb, text, uuid)
  to service_role;

-- Cria o rascunho ATÔMICAMENTE: pedido + linhas + evento 'created' + CHAVE DE
-- IDEMPOTÊNCIA NO MESMO COMMIT (F4.1 — doc 26 §F4.1; molde
-- `fn_create_tenant_with_owner`). p_items: [{product_id, sku, nome, quantity,
-- unit_price_cents, moeda, fonte, price_list_id, price_list_item_id,
-- resolvido_em}] (as linhas chegam PRÉ-RESOLVIDAS pelo resolver TS — o banco
-- valida estrutura, mesma-org e totais; a RESOLUÇÃO nunca é feita no SQL).
--
-- IDEMPOTÊNCIA (defeito F4.1-2 fechado): com p_key, a chave é consumida AQUI,
-- dentro da mesma transação do pedido. Mesma chave + mesmo request_hash →
-- devolve o resultado GRAVADO (replay, sem segundo pedido). Mesma chave +
-- hash diferente → exceção 'idempotency_conflicting_body' (a rota mapeia 409).
-- Qualquer falha depois (gatilho, constraint) rollbacka CHAVE E PEDIDO JUNTOS.
-- p_key vazio = sem idempotência (chamadas internas/seed).
create or replace function public.fn_criar_pedido(
  p_org uuid, p_account uuid, p_external_id text, p_moeda text,
  p_items jsonb, p_actor uuid, p_actor_kind text,
  p_key text default '', p_request_hash bytea default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order uuid;
  v_total bigint := 0;
  v_item jsonb;
  v_account_org uuid;
  v_body jsonb;
  v_anterior record;
begin
  -- ── Idempotência PRIMEIRO: consome a chave antes de mutar qualquer coisa ──
  if p_key <> '' then
    insert into public.idempotency_keys
      (organization_id, key, endpoint, request_hash, status_code, response_body, expires_at)
    values (
      p_org, p_key, 'POST /api/v1/orders',
      coalesce(p_request_hash, ''::bytea),
      201,
      jsonb_build_object('status', 'draft'),
      now() + interval '24 hours'
    )
    on conflict (organization_id, endpoint, key) do nothing
    returning response_body into v_body;

    if v_body is null then
      -- A chave já existe: mesmo corpo devolve o resultado gravado; corpo
      -- diferente é CONFLITO explícito (nunca silêncio).
      select * into v_anterior from public.idempotency_keys
        where organization_id = p_org and endpoint = 'POST /api/v1/orders' and key = p_key;
      if v_anterior.request_hash is distinct from coalesce(p_request_hash, ''::bytea) then
        raise exception 'idempotency_conflicting_body'
          using errcode = 'P0001';
      end if;
      return v_anterior.response_body
        || jsonb_build_object('replay', true, 'status', coalesce(v_anterior.response_body->>'status', 'draft'));
    end if;
  end if;

  -- A conta é da org? (o gatilho das linhas valida o produto; aqui a conta.)
  select organization_id into v_account_org from public.accounts
    where id = p_account and organization_id = p_org;
  if v_account_org is null then
    raise exception 'conta % nao pertence a organizacao %', p_account, p_org
      using errcode = '23514';
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'pedido sem itens' using errcode = '23514';
  end if;

  insert into public.orders
    (organization_id, external_id, external_provider, account_id, origin, status,
     total_cents, currency, ordered_at)
  values
    (p_org, p_external_id, 'manual', p_account, 'manual', 'draft',
     0, p_moeda, now())
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items
      (organization_id, order_id, product_id, sku, nome, quantity,
       unit_price_cents, moeda, fonte, price_list_id, price_list_item_id, resolvido_em)
    values (
      p_org, v_order,
      (v_item->>'product_id')::uuid,
      v_item->>'sku', v_item->>'nome',
      (v_item->>'quantity')::int,
      (v_item->>'unit_price_cents')::bigint,
      v_item->>'moeda',
      v_item->>'fonte',
      (v_item->>'price_list_id')::uuid,
      (v_item->>'price_list_item_id')::uuid,
      coalesce((v_item->>'resolvido_em')::timestamptz, now())
    );
    v_total := v_total + (v_item->>'unit_price_cents')::bigint * (v_item->>'quantity')::int;
  end loop;

  update public.orders set total_cents = v_total where id = v_order;

  perform public.fn_registra_evento_do_pedido(
    p_org, v_order, 'created',
    jsonb_build_object('external_id', p_external_id, 'total_cents', v_total,
                       'itens', jsonb_array_length(p_items)),
    p_actor_kind, p_actor
  );

  v_body := jsonb_build_object(
    'replay', false, 'order_id', v_order, 'external_id', p_external_id,
    'status', 'draft', 'total_cents', v_total
  );

  -- O resultado FINAL grava a resposta da chave (mesma transação): a re-entrega
  -- devolve exatamente o que a primeira execução devolveu.
  if p_key <> '' then
    update public.idempotency_keys
      set response_body = v_body
      where organization_id = p_org and endpoint = 'POST /api/v1/orders' and key = p_key;
  end if;

  return v_body;
end;
$$;

revoke execute on function public.fn_criar_pedido(uuid, uuid, text, text, jsonb, uuid, text, text, bytea)
  from public, anon;
grant execute on function public.fn_criar_pedido(uuid, uuid, text, text, jsonb, uuid, text, text, bytea)
  to authenticated, service_role;

-- Confirma o rascunho: substitui as linhas pela resolução FRESCA (A6 — o
-- snapshot é da confirmação), recalcula o total, vira 'confirmed', registra
-- evento. Recusa pedido sem itens e rascunho de outra org.
create or replace function public.fn_confirmar_pedido(
  p_org uuid, p_order uuid, p_items jsonb, p_actor uuid, p_actor_kind text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_total bigint := 0;
  v_item jsonb;
begin
  select status into v_status from public.orders
    where id = p_order and organization_id = p_org;
  if v_status is null then
    raise exception 'pedido % nao encontrado na organizacao %', p_order, p_org
      using errcode = '23514';
  end if;
  if v_status <> 'draft' then
    raise exception 'pedido em status % nao pode ser confirmado', v_status
      using errcode = '23514';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'pedido sem itens' using errcode = '23514';
  end if;

  delete from public.order_items where order_id = p_order;
  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items
      (organization_id, order_id, product_id, sku, nome, quantity,
       unit_price_cents, moeda, fonte, price_list_id, price_list_item_id, resolvido_em)
    values (
      p_org, p_order,
      (v_item->>'product_id')::uuid,
      v_item->>'sku', v_item->>'nome',
      (v_item->>'quantity')::int,
      (v_item->>'unit_price_cents')::bigint,
      v_item->>'moeda',
      v_item->>'fonte',
      (v_item->>'price_list_id')::uuid,
      (v_item->>'price_list_item_id')::uuid,
      coalesce((v_item->>'resolvido_em')::timestamptz, now())
    );
    v_total := v_total + (v_item->>'unit_price_cents')::bigint * (v_item->>'quantity')::int;
  end loop;

  update public.orders
    set status = 'confirmed', total_cents = v_total
    where id = p_order;

  perform public.fn_registra_evento_do_pedido(
    p_org, p_order, 'confirmed',
    jsonb_build_object('total_cents', v_total, 'itens', jsonb_array_length(p_items)),
    p_actor_kind, p_actor
  );

  return v_total;
end;
$$;

revoke execute on function public.fn_confirmar_pedido(uuid, uuid, jsonb, uuid, text)
  from public, anon;
grant execute on function public.fn_confirmar_pedido(uuid, uuid, jsonb, uuid, text)
  to authenticated, service_role;

-- Edita o rascunho (só draft): substitui linhas pela resolução nova.
create or replace function public.fn_editar_rascunho(
  p_org uuid, p_order uuid, p_items jsonb, p_actor uuid, p_actor_kind text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_total bigint := 0;
  v_item jsonb;
begin
  select status into v_status from public.orders
    where id = p_order and organization_id = p_org;
  if v_status is null then
    raise exception 'pedido % nao encontrado na organizacao %', p_order, p_org
      using errcode = '23514';
  end if;
  if v_status <> 'draft' then
    raise exception 'só rascunho pode ser editado (status %)', v_status
      using errcode = '23514';
  end if;

  delete from public.order_items where order_id = p_order;
  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items
      (organization_id, order_id, product_id, sku, nome, quantity,
       unit_price_cents, moeda, fonte, price_list_id, price_list_item_id, resolvido_em)
    values (
      p_org, p_order,
      (v_item->>'product_id')::uuid,
      v_item->>'sku', v_item->>'nome',
      (v_item->>'quantity')::int,
      (v_item->>'unit_price_cents')::bigint,
      v_item->>'moeda',
      v_item->>'fonte',
      (v_item->>'price_list_id')::uuid,
      (v_item->>'price_list_item_id')::uuid,
      coalesce((v_item->>'resolvido_em')::timestamptz, now())
    );
    v_total := v_total + (v_item->>'unit_price_cents')::bigint * (v_item->>'quantity')::int;
  end loop;

  update public.orders set total_cents = v_total where id = p_order;

  perform public.fn_registra_evento_do_pedido(
    p_org, p_order, 'edited',
    jsonb_build_object('total_cents', v_total, 'itens', jsonb_array_length(p_items)),
    p_actor_kind, p_actor
  );

  return v_total;
end;
$$;

revoke execute on function public.fn_editar_rascunho(uuid, uuid, jsonb, uuid, text)
  from public, anon;
grant execute on function public.fn_editar_rascunho(uuid, uuid, jsonb, uuid, text)
  to authenticated, service_role;

-- Cancela (draft ou confirmed): terminal, com motivo no payload do evento.
create or replace function public.fn_cancelar_pedido(
  p_org uuid, p_order uuid, p_motivo text, p_actor uuid, p_actor_kind text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from public.orders
    where id = p_order and organization_id = p_org;
  if v_status is null then
    raise exception 'pedido % nao encontrado na organizacao %', p_order, p_org
      using errcode = '23514';
  end if;
  if v_status not in ('draft', 'confirmed') then
    raise exception 'pedido em status % nao pode ser cancelado', v_status
      using errcode = '23514';
  end if;

  update public.orders set status = 'cancelled' where id = p_order;

  perform public.fn_registra_evento_do_pedido(
    p_org, p_order, 'cancelled',
    jsonb_build_object('motivo', p_motivo, 'status_anterior', v_status),
    p_actor_kind, p_actor
  );
end;
$$;

revoke execute on function public.fn_cancelar_pedido(uuid, uuid, text, uuid, text)
  from public, anon;
grant execute on function public.fn_cancelar_pedido(uuid, uuid, text, uuid, text)
  to authenticated, service_role;

drop trigger if exists trg_orders_updated_at on public.orders;
create trigger trg_orders_updated_at
  before update on public.orders
  for each row execute function public.fn_set_updated_at();
