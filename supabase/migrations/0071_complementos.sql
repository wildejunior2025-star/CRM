-- Complementos / adicionais por produto (ex.: "monte sua quentinha")
create table if not exists complemento_grupos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  produto_id uuid not null references produtos(id) on delete cascade,
  nome text not null,
  min int not null default 0,
  max int not null default 1,
  ordem int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists complemento_opcoes (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references complemento_grupos(id) on delete cascade,
  nome text not null,
  preco_adicional numeric not null default 0,
  ordem int not null default 0,
  disponivel boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_comp_grupos_produto on complemento_grupos(produto_id);
create index if not exists idx_comp_opcoes_grupo on complemento_opcoes(grupo_id);

alter table complemento_grupos enable row level security;
alter table complemento_opcoes enable row level security;

-- Loja online (anon) precisa ler os complementos do cardápio
drop policy if exists "Anon le complemento_grupos" on complemento_grupos;
create policy "Anon le complemento_grupos" on complemento_grupos for select to anon using (true);
drop policy if exists "Anon le complemento_opcoes" on complemento_opcoes;
create policy "Anon le complemento_opcoes" on complemento_opcoes for select to anon using (true);

-- Autenticados leem os da própria empresa
drop policy if exists "Auth le complemento_grupos" on complemento_grupos;
create policy "Auth le complemento_grupos" on complemento_grupos for select to public
  using (auth.role() = 'authenticated' and empresa_id = current_empresa_id());
drop policy if exists "Auth le complemento_opcoes" on complemento_opcoes;
create policy "Auth le complemento_opcoes" on complemento_opcoes for select to public
  using (auth.role() = 'authenticated' and exists (
    select 1 from complemento_grupos g where g.id = grupo_id and g.empresa_id = current_empresa_id()
  ));

-- Admin da empresa gerencia (insert/update/delete)
drop policy if exists "Admin gerencia complemento_grupos" on complemento_grupos;
create policy "Admin gerencia complemento_grupos" on complemento_grupos for all to public
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());
drop policy if exists "Admin gerencia complemento_opcoes" on complemento_opcoes;
create policy "Admin gerencia complemento_opcoes" on complemento_opcoes for all to public
  using (exists (select 1 from complemento_grupos g where g.id = grupo_id and current_perfil() = 'admin' and g.empresa_id = current_empresa_id()))
  with check (exists (select 1 from complemento_grupos g where g.id = grupo_id and current_perfil() = 'admin' and g.empresa_id = current_empresa_id()));
