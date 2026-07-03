-- Marketplace Mercado Pago: cada loja conecta a PRÓPRIA conta MP (via OAuth) e
-- recebe o PIX direto nela. A plataforma (FWC) cobra uma comissão (application_fee)
-- em cada venda. Substitui o modelo antigo de conta central única.

-- Tokens da conta MP de cada loja. SENSÍVEL: sem policies → nenhum cliente lê/escreve;
-- só o service_role (edge functions) acessa.
create table if not exists public.mercadopago_contas (
  empresa_id    uuid primary key references public.empresas(id) on delete cascade,
  mp_user_id    text not null,
  access_token  text not null,
  refresh_token text,
  public_key    text,
  expires_at    timestamptz,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.mercadopago_contas enable row level security;

-- Estado temporário do OAuth (proteção CSRF): mapeia state -> empresa no início
-- e é consumido no callback. Guarda também pra onde devolver o navegador.
create table if not exists public.mercadopago_oauth_state (
  state       text primary key,
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  return_url  text,
  created_at  timestamptz not null default now()
);
alter table public.mercadopago_oauth_state enable row level security;

-- Flags seguras que o cliente PODE ler pra mostrar "Conectado ✓".
alter table public.empresas add column if not exists mp_conectado boolean not null default false;
alter table public.empresas add column if not exists mp_seller_id text;

-- Comissão da plataforma (% sobre cada venda PIX). Ajustável a qualquer momento.
insert into public.configuracoes_plataforma (chave, valor)
select 'comissao_pix_percent', '2'
where not exists (
  select 1 from public.configuracoes_plataforma where chave = 'comissao_pix_percent'
);
