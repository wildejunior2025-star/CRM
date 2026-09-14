-- =========================================================
-- Migration 0267 - "Já abrimos!" pra quem chamou com a loja fechada
-- =========================================================
-- Cliente que chama antes de a loja abrir recebe o "Estamos fechados" e fica
-- por isso mesmo. Em 14/09/2026 a CDBom teve dois antes das 08:30, um deles
-- escrevendo "Vou querer" — e ninguém voltou nele.
--
-- Agora o robô anota o número quando responde "fechado", e o worker
-- aviso-abertura (cron de 2 em 2 min) manda "Já abrimos" com o link assim que
-- a loja abre DE VERDADE (dentro da grade e sem o botão "Loja fechada").
--
-- Só vale o MESMO dia: quem chamou ontem à noite não recebe nada hoje (a
-- conversa esfriou, e mensagem do nada é o que vira denúncia).
-- =========================================================

create table if not exists aviso_abertura (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  phone       text not null,
  dia         date not null,
  criado_em   timestamptz not null default now(),
  status      text not null default 'pendente'
              check (status in ('pendente', 'enviado', 'pulado', 'falhou')),
  motivo      text,
  enviado_em  timestamptz,
  unique (empresa_id, phone, dia)
);

create index if not exists aviso_abertura_pendente_idx
  on aviso_abertura (dia, status) where status = 'pendente';

-- Só as edge functions (service role) mexem aqui.
alter table aviso_abertura enable row level security;

comment on table aviso_abertura is
  'Quem chamou no WhatsApp com a loja fechada, pra receber "Já abrimos" quando ela abrir no mesmo dia (mig 0267).';

alter table whatsapp_config
  add column if not exists aviso_abertura_ativo boolean not null default true;

comment on column whatsapp_config.aviso_abertura_ativo is
  'Manda "Já abrimos" com o link pra quem chamou com a loja fechada no mesmo dia (mig 0267).';

select cron.schedule(
  'aviso-abertura',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/aviso-abertura',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) as request_id
  $$
);
