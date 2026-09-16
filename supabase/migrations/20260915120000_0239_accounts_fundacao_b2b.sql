-- 0239 — FUNDACAO DE CONTAS B2B (RevenueOS, Fase 2 — docs/our-product/21 §8)
--
-- O QUE: `accounts` é a EMPRESA-CLIENTE do tenant (o "Customer Account" do
-- grafo de receita), e `contacts.account_id` é o vínculo OPCIONAL de uma
-- pessoa à sua empresa. Antes disto o Deskcomm só conhecia pessoa física:
-- o B2B não tinha onde morar (auditoria 03/06: "Customer Account — MISSING").
--
-- O QUE NÃO É: account NÃO é a organização (isso é o tenant) e não substitui
-- nenhum registro existente — é uma camada ACIMA de `contacts`, aditiva e
-- opcional: contato sem conta segue existindo (B2C e nichos atuais intactos).
--
-- DECISÕES DE CONTO (mínimo seguro da Fase 2):
--  - `settings jsonb` é a porta de pricing/regras de pedido da Fase 3-4 —
--    nasce `{}` SEM schema fixo de propósito (DIRC: não especular campos).
--  - `external_id` é o identificador de referência do operador (ERP, planilha).
--    Único por organização QUANDO presente (índice parcial).
--  - status fecha o ciclo de vida no BANCO (active/inactive/archived) — não
--    há DELETE na API; remover conta é arquivar.
--  - `owner_user_id` é o rep responsável (mesmo padrão de
--    `crm_leads.owner_user_id`): opcional, SET NULL no usuário removido.
--  - Vínculo contato↔conta é validado NA MESMA ORGANIZAÇÃO por trigger
--    (`fn_valida_conta_da_mesma_org`): a FK simples não enxerga tenant, e um
--    contato apontando para conta de outra org seria vazamento silencioso.
--    ON DELETE SET NULL: remover conta NUNCA apaga contato.
--
-- RLS: molde `catalog_products` (0204/0177) — leitura org-flat, escrita de
-- `manager` para cima. Tabela é insumo comercial do funil B2B.

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  external_id text,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  settings jsonb not null default '{}'::jsonb,
  owner_user_id uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.accounts is
  'Conta B2B: a empresa-cliente do tenant (RevenueOS Fase 2). Pessoa física é '
  || 'contacts.account_id; pricing/regras de pedido entram por settings (Fase 3-4).';

-- Referência externa (ERP/planilha) única POR ORGANIZAÇÃO quando presente.
create unique index if not exists accounts_org_external_id_unique
  on public.accounts (organization_id, external_id)
  where external_id is not null;

-- Listagem da tela e dos joins futuros de pricing: org + status.
create index if not exists accounts_org_status_idx
  on public.accounts (organization_id, status);

-- Contatos de uma conta (painel da tela e contagem futura).
create index if not exists contacts_account_id_idx
  on public.contacts (account_id)
  where account_id is not null;

alter table public.accounts enable row level security;

drop policy if exists accounts_select on public.accounts;
create policy accounts_select on public.accounts
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

drop policy if exists accounts_write on public.accounts;
create policy accounts_write on public.accounts
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

-- A FK simples (contacts.account_id → accounts.id) não enxerga tenant: sem
-- este gatilho, um insert direto poderia vincular contato da org A à conta da
-- org B. A API valida (422), mas o banco é a autoridade (regra 5 do pedido).
create or replace function public.fn_valida_conta_da_mesma_org()
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

revoke execute on function public.fn_valida_conta_da_mesma_org() from public, anon;
grant execute on function public.fn_valida_conta_da_mesma_org() to authenticated, service_role;

drop trigger if exists trg_contacts_valida_conta on public.contacts;
create trigger trg_contacts_valida_conta
  before insert or update of account_id on public.contacts
  for each row execute function public.fn_valida_conta_da_mesma_org();

-- updated_at canônico (mesmo gatilho das demais tabelas).
drop trigger if exists trg_accounts_updated_at on public.accounts;
create trigger trg_accounts_updated_at
  before update on public.accounts
  for each row execute function public.fn_set_updated_at();

-- A coluna nova vai pelo ALTER (a tabela contacts já existe em todo clone).
alter table public.contacts
  add column if not exists account_id uuid references public.accounts(id) on delete set null;

comment on column public.contacts.account_id is
  'Conta B2B da pessoa (opcional — B2C segue sem conta). Mesma organização, '
  || 'garantido por trg_contacts_valida_conta. Conta removida → NULL.';
