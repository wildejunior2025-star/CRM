-- =========================================================
-- Migration 0269 - Tutorial em vídeo pra quem fala pela primeira vez
-- =========================================================
-- Cliente novo recebe a boas-vindas com o link do cardápio e, muitas vezes,
-- some: abriu o link e travou. Na CDBom (14/09/2026) teve cliente escrevendo
-- "Não sei mexe muito não" / "Não sei se deu certo".
--
-- Agora o robô agenda, no primeiro contato, um segundo aviso pra 5 minutos
-- depois: "Tá com dificuldade de comprar pelo link? Assiste esse tutorial" com
-- o vídeo. O worker tutorial-followup (cron de 1 em 1 min) só manda se o
-- cliente NÃO respondeu, não pediu e a loja não assumiu a conversa.
--
-- Uma vez por cliente, pra sempre (unique empresa+telefone).
-- =========================================================

create table if not exists tutorial_followup (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id) on delete cascade,
  phone         text not null,
  criado_em     timestamptz not null default now(),
  agendado_para timestamptz not null,
  status        text not null default 'pendente'
                check (status in ('pendente', 'enviado', 'pulado', 'falhou')),
  motivo        text,
  enviado_em    timestamptz,
  unique (empresa_id, phone)
);

create index if not exists tutorial_followup_pendente_idx
  on tutorial_followup (agendado_para) where status = 'pendente';

alter table tutorial_followup enable row level security;

comment on table tutorial_followup is
  'Vídeo tutorial 5 min depois da boas-vindas pra cliente que fala pela primeira vez e não responde (mig 0269).';

alter table whatsapp_config
  add column if not exists tutorial_ativo boolean not null default true,
  add column if not exists tutorial_url   text;

comment on column whatsapp_config.tutorial_ativo is
  'Manda o vídeo tutorial pra cliente de primeiro contato que não respondeu em 5 min (mig 0269).';
comment on column whatsapp_config.tutorial_url is
  'Vídeo tutorial da loja. Vazio = o vídeo padrão da FWC (mig 0269).';

select cron.schedule(
  'tutorial-followup',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/tutorial-followup',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) as request_id
  $$
);
