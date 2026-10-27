-- Cancelamento automatico da NFC-e (27/10/2026): loja com emissao automatica ligada
-- que cancela a venda depois da nota tem a nota cancelada sozinha. Esta tabela
-- guarda as tentativas do robo (nfce-auto) por nota, pra nao repetir pra sempre.
create table if not exists public.nfce_auto_cancel (
  nota_id      uuid primary key references public.nfce_notas(id) on delete cascade,
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  tentativas   integer not null default 0,
  ultimo_erro  text,
  proxima_em   timestamptz not null default now(),
  desistiu     boolean not null default false,
  avisado      boolean not null default false,
  criado_em    timestamptz not null default now()
);
alter table public.nfce_auto_cancel enable row level security;
