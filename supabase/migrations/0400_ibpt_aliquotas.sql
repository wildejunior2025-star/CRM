-- Cache da tabela do IBPT (Lei 12.741/2012): alíquota aproximada de tributos por NCM e UF.
-- A emissão da NFC-e consulta a API do IBPT uma vez por NCM e guarda aqui até a
-- vigência acabar (a tabela muda a cada ~2 meses). Só a edge function lê/grava
-- (service role): RLS ligada e sem policy.
create table if not exists public.ibpt_aliquotas (
  ncm            text        not null,
  uf             text        not null,
  nacional       numeric(6,2) not null default 0,
  estadual       numeric(6,2) not null default 0,
  importado      numeric(6,2) not null default 0,
  municipal      numeric(6,2) not null default 0,
  descricao      text,
  chave          text,
  versao         text,
  vigencia_fim   date,
  atualizado_em  timestamptz not null default now(),
  primary key (ncm, uf)
);

alter table public.ibpt_aliquotas enable row level security;
