-- VIGIA DO WHATSAPP DAS LOJAS (01/10/2026)
--
-- POR QUE EXISTE
-- O teste grátis do Railway venceu com duas faturas atrasadas no cartão, o
-- Evolution inteiro foi pausado e NINGUÉM soube: o Zebu passou a manhã fazendo
-- pedidos sem nenhum cliente receber aviso, e a tela do Super ADM continuava
-- mostrando as lojas como "Conectado" — ela lia o campo `ativo` da tabela, não
-- o estado real. Entre a queda (30/09 18:58) e a descoberta foram ~19 horas.
--
-- O QUE ESTA TABELA GUARDA
-- O último estado REAL de cada instância, visto pela própria API do Evolution:
--   aberto        → conectado, tudo certo
--   desconectado  → o servidor responde, mas aquele número caiu (QR a ler)
--   servidor_fora → o Evolution não responde: TODAS as lojas estão mudas
-- É daqui que a tela do Super ADM passa a ler (em vez de adivinhar) e é daqui
-- que sai a decisão de avisar — `avisado_em` existe pra não repetir o aviso a
-- cada 10 minutos.
create table if not exists public.monitor_whatsapp (
  instancia   text primary key,
  empresa_id  uuid references public.empresas(id) on delete cascade,
  loja        text,
  estado      text not null default 'desconhecido',
  detalhe     text,
  mudou_em    timestamptz not null default now(),
  checado_em  timestamptz not null default now(),
  avisado_em  timestamptz
);

comment on table public.monitor_whatsapp is
  'Estado real de cada instância do WhatsApp, lido do Evolution de 5 em 5 min (mig 0291)';

alter table public.monitor_whatsapp enable row level security;

-- Só o super admin lê — é painel da plataforma, não da loja.
drop policy if exists "super admin le monitor" on public.monitor_whatsapp;
create policy "super admin le monitor" on public.monitor_whatsapp
  for select using (current_perfil() = 'super_admin');

-- Quem escreve é a edge function (service_role, que ignora RLS).

-- ── Quem chama ───────────────────────────────────────────────────────────────
-- De 5 em 5 min. A função só avisa quando o estado MUDA, então rodar de perto
-- não vira spam — e 5 min é o atraso máximo entre a loja ficar muda e você
-- saber.
select cron.unschedule('monitor-whatsapp')
  where exists (select 1 from cron.job where jobname = 'monitor-whatsapp');

select cron.schedule(
  'monitor-whatsapp',
  '*/5 * * * *',
  $cron$ select net.http_post(
       url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/monitor-whatsapp',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := '{}'::jsonb
     ); $cron$
);

-- A função vai deployada com --no-verify-jwt: o gatilho do cron não leva JWT.
