-- FILA DE ENVIO DO WHATSAPP (19/11/2026)
--
-- POR QUE EXISTE
-- A CDBom levou 24h de restrição da Meta por "mensagens automáticas ou em
-- massa" sem ter feito disparo nenhum: foi o RITMO. A resposta automática do
-- catálogo, com texto e link idênticos, saiu pra 11 números diferentes em 40
-- minutos — três deles em 49 segundos.
--
-- A primeira versão do freio segurava a resposta dormindo dentro do webhook.
-- Funcionava, mas prendia a chamada por até 20 s e, se o Evolution desistisse
-- de esperar, a mensagem se perdia. REGRA DO WILDE: nunca deixar de enviar.
--
-- Então o que não cabe agora entra NA FILA e sai na vez dele. Ninguém fica sem
-- resposta; só espera.
create table if not exists whatsapp_fila (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  phone       text not null,
  texto       text not null,
  -- 'robo' = resposta automática; 'pedido' = aviso de pedido.
  tipo        text not null default 'robo',
  enviar_apos timestamptz not null default now(),
  criado_em   timestamptz not null default now(),
  enviado_em  timestamptz,
  tentativas  smallint not null default 0,
  erro        text
);

-- O índice que o worker usa: o que está esperando, na ordem da vez.
create index if not exists whatsapp_fila_esperando
  on whatsapp_fila (empresa_id, enviar_apos)
  where enviado_em is null;

alter table whatsapp_fila enable row level security;
-- Sem policy nenhuma de propósito: isto é máquina falando com máquina. Só a
-- chave de serviço (que ignora RLS) mexe aqui. Nenhuma loja precisa ver a
-- fila da outra, e o navegador não tem o que fazer com ela.

-- ── Marcar a vez ────────────────────────────────────────────────────────────
-- Devolve NULL quando pode sair AGORA, ou o horário agendado quando entrou na
-- fila. Tudo numa transação só porque dois webhooks chegam juntos: se cada um
-- fizesse a conta por fora, os dois achariam que a vaga está livre.
create or replace function whatsapp_fila_agendar(
  p_empresa   uuid,
  p_phone     text,
  p_texto     text,
  p_tipo      text default 'robo',
  p_intervalo int default 20
) returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_ultimo timestamptz;
  v_fila   timestamptz;
  v_prox   timestamptz;
  v_chave  text := right(regexp_replace(coalesce(p_phone,''), '[^0-9]', '', 'g'), 8);
begin
  -- Quando saiu a última automática desta loja PRA OUTRO NÚMERO. Duas falas
  -- seguidas pra mesma pessoa é conversa normal e não espera nada.
  select max(created_at) into v_ultimo
    from whatsapp_conversas
   where empresa_id = p_empresa
     and role = 'assistant'
     and origem is null
     and created_at > now() - interval '5 minutes'
     and right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 8) <> v_chave;

  -- E o que já está esperando: o novo entra atrás, senão a fila fura.
  select max(enviar_apos) into v_fila
    from whatsapp_fila
   where empresa_id = p_empresa and enviado_em is null;

  v_prox := greatest(
    coalesce(v_ultimo, now() - interval '1 hour'),
    coalesce(v_fila,   now() - interval '1 hour')
  ) + make_interval(secs => p_intervalo);

  if v_prox <= now() then
    return null;   -- a vaga está livre: manda direto
  end if;

  insert into whatsapp_fila (empresa_id, phone, texto, tipo, enviar_apos)
  values (p_empresa, p_phone, p_texto, p_tipo, v_prox);
  return v_prox;
end;
$$;

revoke all on function whatsapp_fila_agendar(uuid, text, text, text, int) from public, anon, authenticated;

-- ── O carteiro ──────────────────────────────────────────────────────────────
-- De minuto em minuto. Cada mensagem já tem a hora dela gravada, então o
-- worker só entrega o que venceu — o espaçamento vem de quem agendou.
select cron.unschedule('whatsapp-fila') where exists (
  select 1 from cron.job where jobname = 'whatsapp-fila'
);

select cron.schedule(
  'whatsapp-fila',
  '* * * * *',
  $cron$ select net.http_post(
       url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/whatsapp-fila',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body    := '{}'::jsonb,
       timeout_milliseconds := 55000
     ); $cron$
);
