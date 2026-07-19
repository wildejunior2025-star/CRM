-- Quebra EXATA do repasse iFood, lida do PDF de Repasse (além do total já guardado).
-- Assim a semana importada mostra Comissões/Promoções/Recebido-direto batendo com o PDF,
-- em vez de cair na estimativa.
alter table public.ifood_repasse_semanal
  add column if not exists comissoes       numeric,  -- total de taxas + comissões do iFood (magnitude positiva)
  add column if not exists promocoes        numeric,  -- promoções incentivadas pela loja (magnitude positiva)
  add column if not exists recebido_direto  numeric;  -- valores recebidos direto na loja (dinheiro/pix/maquininha)
