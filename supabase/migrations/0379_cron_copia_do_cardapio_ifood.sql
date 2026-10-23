-- A cópia do cardápio do iFood precisa andar sozinha (23/10/2026)
--
-- É dela que sai a categoria de cada item (o pedido não diz), e o lojista mexe
-- no cardápio dele sem avisar ninguém: cria item, renomeia, reativa categoria
-- pausada. Sem atualizar, a categoria de um item novo chega vazia e ele cai no
-- degrau "desconhecido" — que não é errado (vai pra cozinha marcado), mas vira
-- ruído se a cópia ficar meses parada.
--
-- Uma vez por dia, de madrugada: nenhuma loja está vendendo às 04:40, e a
-- leitura é pesada (um GET de catálogo por loja do iFood).
select cron.schedule(
  'ifood-cardapio-sync',
  '40 7 * * *',   -- 04:40 em Fortaleza (UTC-3)
  $$
  select net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/ifood-integration',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"acao": "cardapio_sync"}'::jsonb,
    timeout_milliseconds := 180000
  ) as request_id
  $$
);
