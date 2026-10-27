-- 0417 — CATEGORIA DE INSUMO DA PRÓPRIA LOJA, com figurinha
--
-- 27/10/2026: a lista de categorias de matéria-prima era fixa no código (Hortifruti, Carnes e frios…).
-- O Wilde pediu pra loja criar as dela ("Temperos") e escolher a figurinha, pra ficar no padrão das outras.
-- O insumo continua guardando a categoria como TEXTO (materias_primas.categoria); aqui fica só o
-- nome + figurinha das que a loja criou. No dinheiro (rateio da nota) o insumo de categoria própria
-- cai numa categoria padrão pelo nome — essa lista é só pra organizar o estoque.

create table if not exists categorias_insumo (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null default current_empresa_id() references empresas(id) on delete cascade,
  nome        text not null check (length(trim(nome)) between 1 and 40),
  icone       text not null default '📦' check (length(icone) <= 16),
  created_at  timestamptz not null default now(),
  unique (empresa_id, nome)
);

alter table categorias_insumo enable row level security;

drop policy if exists categorias_insumo_ler on categorias_insumo;
create policy categorias_insumo_ler on categorias_insumo for select to authenticated
  using (empresa_id = (select current_empresa_id()));

drop policy if exists categorias_insumo_dono on categorias_insumo;
create policy categorias_insumo_dono on categorias_insumo for all to authenticated
  using (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin')
  with check (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin');
