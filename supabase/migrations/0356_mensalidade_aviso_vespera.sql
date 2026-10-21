-- Ultimo aviso de mensalidade: 22h da vespera do dia que trava (21/10/2026)
--
-- POR QUE EXISTE
-- O Zebu ia abrir travado em 22/10 sem ter recebido nada no dia 21. Os avisos
-- que existiam sao:
--   08h do dia do vencimento  -> link pra pagar          (cron_link)
--   07h do dia seguinte       -> "esta em atraso"        (cron, whatsapp_atraso)
--   07h do dia que trava      -> aviso de bloqueio       (cron, whatsapp_bloqueio)
-- Os dois primeiros ficam longe do dia que trava, e o terceiro chega no proprio
-- dia, quando a tela JA travou — nao serve de aviso, so de explicacao.
--
-- Faltava a ultima chance: na noite anterior, com hora, valor e link pra pagar
-- na hora. Isso tira da FWC a fama de ter travado sem avisar.
--
-- 22h em Fortaleza (UTC-3, sem horario de verao) = 01:00 UTC do dia seguinte.
-- As 01:00 UTC ainda e o dia anterior no relogio local, entao o hojeBR() da
-- funcao devolve o dia certo e ela procura quem trava "amanha".

select cron.unschedule('mensalidade-vespera')
 where exists (select 1 from cron.job where jobname = 'mensalidade-vespera');

select cron.schedule(
  'mensalidade-vespera',
  '0 1 * * *',
  $cron$
  select net.http_post(
    url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/mensalidade',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{"action": "cron_vespera"}'::jsonb
  )
  $cron$
);
