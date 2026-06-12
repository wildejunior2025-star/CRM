-- =========================================================
-- CRM Depósito de Bebidas - Migration 0009
-- Módulo: Categorias de produtos por empresa
-- =========================================================

create table if not exists categorias (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  nome text not null,
  created_at timestamptz not null default now(),
  unique (empresa_id, nome)
);

-- RLS
alter table categorias enable row level security;

create policy "empresa_own_categorias" on categorias
  for all
  using (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());

-- Popula categorias padrão para empresas que já existem
insert into categorias (empresa_id, nome)
select e.id, unnest(array['cerveja','refrigerante','agua','energetico','destilado','suco','outros'])
from empresas e
on conflict do nothing;
