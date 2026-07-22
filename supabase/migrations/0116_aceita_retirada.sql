-- Liga/desliga a opcao "Retirar na loja" POR LOJA.
--
-- Vem TRUE por padrao de proposito: nenhuma loja que ja esta vendendo hoje
-- pode sentir diferenca. So muda pra quem for nas configuracoes e desligar.
--
-- ESCOPO: vale para a loja online (cardapio) e para o portal do cliente.
-- NAO afeta o bot do WhatsApp (a logica dele nao foi tocada), nem o balcao,
-- nem as mesas, nem o iFood (la quem decide entrega/retirada e o proprio iFood).

alter table empresas
  add column if not exists aceita_retirada boolean not null default true;

comment on column empresas.aceita_retirada is
  'Se false, a loja online e o portal nao oferecem "Retirar na loja" — so entrega. Nao afeta o bot do WhatsApp, balcao, mesas nem iFood.';
