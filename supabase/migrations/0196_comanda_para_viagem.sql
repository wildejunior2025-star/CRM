-- 0196_comanda_para_viagem.sql
-- Pedido de mesa marcado como PARA VIAGEM.
--
-- Caso do Saidera (26/08/2026): o garcom nao tinha como avisar a cozinha que o
-- pedido era pra viagem. Ele ate escrevia "viagem" na observacao do item, mas
-- escrevia DEPOIS de mandar pra cozinha -- e a impressora le a observacao do
-- item no INSERT, entao o papel ja tinha saido sem o aviso.
--
-- A marcacao e da COMANDA inteira (nao do item): "essa mesa e viagem" e uma
-- decisao da mesa, e assim todo item enviado dali pra frente sai avisando,
-- sem o garcom ter que lembrar item por item. O app cola "PARA VIAGEM" na
-- observacao de cada item no envio, que e o campo que a termica imprime.
--
-- Some sozinho quando a mesa fecha: a proxima comanda nasce com false.

alter table public.comandas
  add column if not exists para_viagem boolean not null default false;

comment on column public.comandas.para_viagem is
  'Pedido para viagem. O Salao cola "PARA VIAGEM" na observacao de cada item enviado, que e o que sai impresso na cozinha.';
