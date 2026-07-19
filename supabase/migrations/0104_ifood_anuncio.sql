-- Valor do "Pacote de anúncios" do iFood que a loja informa por semana.
-- O anúncio varia toda semana e o iFood cobra à parte (não vem por pedido);
-- é a única peça que falta pra o repasse bater. A loja digita 1 número/semana.
create table if not exists public.ifood_anuncio (
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  semana_ini    date not null,               -- segunda-feira que abre a semana
  valor         numeric not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (empresa_id, semana_ini)
);
alter table public.ifood_anuncio enable row level security;
create policy "Loja gerencia seu anuncio iFood" on public.ifood_anuncio
  for all using (empresa_id = current_empresa_id()) with check (empresa_id = current_empresa_id());
create policy "Super admin anuncio iFood" on public.ifood_anuncio
  for all using (current_perfil() = 'super_admin') with check (current_perfil() = 'super_admin');
