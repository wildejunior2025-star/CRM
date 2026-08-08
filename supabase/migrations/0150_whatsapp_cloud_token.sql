-- Token da Cloud API por loja (Cadastro Incorporado).
--
-- No Cadastro Incorporado cada loja conecta o WhatsApp DELA e a Meta devolve um
-- token para aquela WABA. Esse token não pode morar em `whatsapp_config`: lá a
-- policy "Admin gerencia whatsapp da propria empresa" deixa o próprio lojista
-- ler a linha inteira, e o token dá acesso à integração.
--
-- Esta tabela fica com RLS ligada e SEM nenhuma policy — ou seja, ninguém
-- alcança por PostgREST. Só as edge functions (service_role, que ignora RLS)
-- leem e escrevem.

create table if not exists public.whatsapp_cloud_tokens (
  empresa_id  uuid primary key references public.empresas(id) on delete cascade,
  token       text not null,
  waba_id     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.whatsapp_cloud_tokens enable row level security;

revoke all on public.whatsapp_cloud_tokens from anon, authenticated;

comment on table public.whatsapp_cloud_tokens is
  'Token da Cloud API por loja, vindo do Cadastro Incorporado. Sem policy de propósito: só service_role acessa.';
