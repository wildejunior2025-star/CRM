-- ENCOSTO DO MOTOBOY: valor garantido por dia, somado as corridas no acerto.
-- O valor padrao mora no cadastro dele (profiles.entregador_encosto); o dono pode
-- mudar o de UM dia (entregador_encosto_dia) e e esse registro que guarda se ja foi pago.
alter table public.profiles
  add column if not exists entregador_encosto numeric(10,2) not null default 0;

create table if not exists public.entregador_encosto_dia (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  entregador_id uuid not null references public.profiles(id) on delete cascade,
  data date not null,
  valor numeric(10,2) not null default 0 check (valor >= 0),
  pago boolean not null default false,
  pago_em timestamptz,
  created_at timestamptz not null default now(),
  unique (entregador_id, data)
);

alter table public.entregador_encosto_dia enable row level security;

create policy "loja ve o encosto" on public.entregador_encosto_dia
  for select to authenticated using (empresa_id = current_empresa_id());
create policy "loja lanca o encosto" on public.entregador_encosto_dia
  for insert to authenticated with check (empresa_id = current_empresa_id() and current_perfil() in ('admin','vendedor'));
create policy "loja muda o encosto" on public.entregador_encosto_dia
  for update to authenticated using (empresa_id = current_empresa_id() and current_perfil() in ('admin','vendedor'))
  with check (empresa_id = current_empresa_id() and current_perfil() in ('admin','vendedor'));
