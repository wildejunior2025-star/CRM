-- =========================================================
-- Migration 0270 - Banners promocionais com IA
-- =========================================================
-- Visto na Brendi em 14/09/2026 e aprovado pelo usuário no nosso jeito: a IA
-- gera só a CENA (foto real do produto numa cena de propaganda, sem letra) e o
-- sistema escreve o texto por cima (preço do cadastro, acento certo). O banner
-- aparece no topo da Loja Online e o clique abre o produto.
--
-- banners           → a biblioteca da loja (o que foi salvo)
-- banner_geracoes   → cada cena gerada (é o que custa); dá o limite do mês
-- bucket "banners"  → cenas e banners prontos, leitura pública
-- =========================================================

create table if not exists banners (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  produto_id  uuid references produtos(id) on delete set null,
  tema        text,
  promocao    text,
  textos      jsonb not null default '{}'::jsonb,
  cena_url    text,
  imagem_url  text not null,
  ativo       boolean not null default true,
  ordem       integer not null default 0,
  criado_em   timestamptz not null default now(),
  criado_por  uuid references auth.users(id) on delete set null
);

create index if not exists banners_empresa_idx on banners (empresa_id, ativo, ordem);

alter table banners enable row level security;

drop policy if exists "banners loja le" on banners;
create policy "banners loja le" on banners
  for select to authenticated using (empresa_id = current_empresa_id());

drop policy if exists "banners loja grava" on banners;
create policy "banners loja grava" on banners
  for insert to authenticated with check (empresa_id = current_empresa_id());

drop policy if exists "banners loja altera" on banners;
create policy "banners loja altera" on banners
  for update to authenticated using (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());

drop policy if exists "banners loja apaga" on banners;
create policy "banners loja apaga" on banners
  for delete to authenticated using (empresa_id = current_empresa_id());

-- A Loja Online é pública: qualquer um vê os banners ATIVOS.
drop policy if exists "banners publico ativos" on banners;
create policy "banners publico ativos" on banners
  for select to anon, authenticated using (ativo = true);

comment on table banners is
  'Banners promocionais da loja (IA gera a cena, o sistema escreve o texto). Ativos aparecem no topo da Loja Online (mig 0270).';

create table if not exists banner_geracoes (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  produto_id  uuid references produtos(id) on delete set null,
  cena_url    text,
  criado_em   timestamptz not null default now(),
  criado_por  uuid references auth.users(id) on delete set null
);

create index if not exists banner_geracoes_mes_idx on banner_geracoes (empresa_id, criado_em);

alter table banner_geracoes enable row level security;

drop policy if exists "banner_geracoes loja le" on banner_geracoes;
create policy "banner_geracoes loja le" on banner_geracoes
  for select to authenticated using (empresa_id = current_empresa_id());

comment on table banner_geracoes is
  'Cada cena gerada pela IA (é o que custa). Só a edge function gerar-banner grava. Base do limite mensal (mig 0270).';

-- ── Storage ────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('banners', 'banners', true)
on conflict do nothing;

drop policy if exists "banners: leitura publica" on storage.objects;
create policy "banners: leitura publica" on storage.objects
  for select to public using (bucket_id = 'banners');

drop policy if exists "banners: loja sobe" on storage.objects;
create policy "banners: loja sobe" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'banners' and (storage.foldername(name))[1] = current_empresa_id()::text);

drop policy if exists "banners: loja apaga" on storage.objects;
create policy "banners: loja apaga" on storage.objects
  for delete to authenticated
  using (bucket_id = 'banners' and (storage.foldername(name))[1] = current_empresa_id()::text);
