-- 0240 — FUNDACAO DE PRECIFICACAO B2B (RevenueOS, Fase 3 — docs/our-product/24)
--
-- O QUE: `price_lists` (lista de precos por organizacao) e `price_list_items`
-- (preco por produto dentro da lista) + `accounts.price_list_id` (a conta aponta
-- para SUA lista). O preco BASE continua sendo `catalog_products.preco_cents` —
-- nada paralelo: a lista SOBREPÕE o base por produto (resolver deterministico
-- em `lib/pricing/`, Fase 3; consumo pelo Order Engine, Fase 4).
--
-- CONTORNOS (menores suposicoes explicitas — doc 24 §2):
--  - A4: o item e precificado na moeda da LISTA (moeda e da lista, nao do item).
--  - Sem preco por quantidade (A5); sem conversao de moeda; sem desconto como
--    entidade (o guardrail de promessa da IA continua sendo o teto de saida).
--
-- SEGURANCA: RLS no molde catalog_products/accounts (leitura org-flat, escrita
-- manager+). FKs simples nao enxergam tenant, entao gatilhos same-org validam
-- (a) lista/item na mesma organizacao, (b) accounts.price_list_id na mesma
-- organizacao — o mesmo padrao do trg_contacts_valida_conta (0239).

create table if not exists public.price_lists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  nome text not null,
  moeda text not null default 'BRL',
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.price_lists is
  'Lista de precos B2B (RevenueOS Fase 3). Sobrepoe o preco base do catalogo '
  || 'por produto, para as contas que apontam para ela (accounts.price_list_id).';

alter table public.price_lists
  add constraint price_lists_moeda_iso check (moeda ~ '^[A-Z]{3}$');

create table if not exists public.price_list_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  price_list_id uuid not null references public.price_lists(id) on delete cascade,
  product_id uuid not null references public.catalog_products(id) on delete cascade,
  preco_cents bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_list_items_preco_nao_negativo check (preco_cents >= 0),
  constraint price_list_items_lista_produto_unica unique (price_list_id, product_id)
);

comment on table public.price_list_items is
  'Preco do produto DENTRO de uma lista (moeda da lista). Sobrepoe o preco '
  || 'base do catalogo para as contas desta lista. Produto removido → item '
  || 'some junto (on delete cascade): item sem produto nao tem sentido.';

create index if not exists price_list_items_product_idx
  on public.price_list_items (product_id);

create index if not exists price_lists_org_status_idx
  on public.price_lists (organization_id, status);

-- A conta aponta para SUA lista; removida a lista, a conta volta ao preco base.
alter table public.accounts
  add column if not exists price_list_id uuid references public.price_lists(id) on delete set null;

comment on column public.accounts.price_list_id is
  'Lista de precos da conta (opcional — sem lista, vale o preco base do '
  || 'catalogo). Mesma organizacao, garantido por trg_accounts_valida_lista.';

alter table public.price_lists enable row level security;
alter table public.price_list_items enable row level security;

drop policy if exists price_lists_select on public.price_lists;
create policy price_lists_select on public.price_lists
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists price_lists_write on public.price_lists;
create policy price_lists_write on public.price_lists
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists price_list_items_select on public.price_list_items;
create policy price_list_items_select on public.price_list_items
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists price_list_items_write on public.price_list_items;
create policy price_list_items_write on public.price_list_items
  using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  )
  with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

-- A FK simples nao enxerga tenant: o item tem de pertencer a lista E ao
-- produto DA MESMA organizacao (a organiz_id da linha ja amarra um dos lados
-- pelo gatilho abaixo; o outro lado e o que sem isto vazaria por insert direto).
create or replace function public.fn_valida_item_da_mesma_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.price_lists
    where id = new.price_list_id and organization_id = new.organization_id
  ) then
    raise exception 'lista % nao pertence a organizacao %', new.price_list_id, new.organization_id
      using errcode = '23514';
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

revoke execute on function public.fn_valida_item_da_mesma_org() from public, anon;
grant execute on function public.fn_valida_item_da_mesma_org() to authenticated, service_role;

drop trigger if exists trg_price_list_items_valida_org on public.price_list_items;
create trigger trg_price_list_items_valida_org
  before insert or update of price_list_id, product_id on public.price_list_items
  for each row execute function public.fn_valida_item_da_mesma_org();

create or replace function public.fn_valida_lista_da_mesma_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.price_list_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.price_lists
    where id = new.price_list_id and organization_id = new.organization_id
  ) then
    raise exception 'lista % nao pertence a organizacao %', new.price_list_id, new.organization_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_valida_lista_da_mesma_org() from public, anon;
grant execute on function public.fn_valida_lista_da_mesma_org() to authenticated, service_role;

drop trigger if exists trg_accounts_valida_lista on public.accounts;
create trigger trg_accounts_valida_lista
  before insert or update of price_list_id on public.accounts
  for each row execute function public.fn_valida_lista_da_mesma_org();

drop trigger if exists trg_price_lists_updated_at on public.price_lists;
create trigger trg_price_lists_updated_at
  before update on public.price_lists
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_price_list_items_updated_at on public.price_list_items;
create trigger trg_price_list_items_updated_at
  before update on public.price_list_items
  for each row execute function public.fn_set_updated_at();
