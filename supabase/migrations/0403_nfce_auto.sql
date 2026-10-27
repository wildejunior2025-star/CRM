-- NFC-e automatica (27/10/2026). DESLIGADA por padrao: so emite sozinha a loja
-- que ligar, e so pras formas de pagamento marcadas.
--
-- nfce_auto_formas guarda GRUPOS: 'cartao' (credito/debito/cartao), 'pix'
-- (pix/pix_entrega/online), 'dinheiro', 'vale' (pluxee/alelo/vr/ticket/vale).
-- fiado e pagamento sem forma NUNCA emitem sozinhos.
--
-- nfce_auto_desde carimba o momento em que a loja LIGOU: venda de antes disso
-- nao vira nota automatica (nada retroativo).
alter table public.empresa_fiscal
  add column if not exists nfce_auto boolean not null default false,
  add column if not exists nfce_auto_formas text[] not null default '{}',
  add column if not exists nfce_auto_espera_min integer not null default 2,
  add column if not exists nfce_auto_desde timestamptz;

create or replace function public.nfce_auto_carimba_desde() returns trigger
language plpgsql as $$
begin
  if new.nfce_auto and (tg_op = 'INSERT' or not coalesce(old.nfce_auto, false)) then
    new.nfce_auto_desde := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_nfce_auto_desde on public.empresa_fiscal;
create trigger trg_nfce_auto_desde before insert or update on public.empresa_fiscal
  for each row execute function public.nfce_auto_carimba_desde();

-- Controle do robo: quantas vezes tentou cada venda e por que falhou.
create table if not exists public.nfce_auto_tentativas (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  pedido_id     uuid,
  comanda_id    uuid,
  tentativas    integer not null default 0,
  ultimo_erro   text,
  proxima_em    timestamptz not null default now(),
  desistiu      boolean not null default false,
  avisado       boolean not null default false,
  criado_em     timestamptz not null default now(),
  check ((pedido_id is not null) <> (comanda_id is not null))
);
create unique index if not exists nfce_auto_tent_pedido  on public.nfce_auto_tentativas (pedido_id)  where pedido_id  is not null;
create unique index if not exists nfce_auto_tent_comanda on public.nfce_auto_tentativas (comanda_id) where comanda_id is not null;
alter table public.nfce_auto_tentativas enable row level security;
