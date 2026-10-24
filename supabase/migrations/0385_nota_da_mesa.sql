-- NOTA FISCAL DA VENDA DE MESA (24/10/2026)
--
-- A comanda fechada nao passa por pedidos_delivery, entao a nota dela nao tinha
-- onde se prender: `nfce_notas.pedido_id` apontava pra uma tabela que a mesa
-- nunca visita. Sem isso, a mesma comanda podia virar duas notas, porque a
-- checagem de "ja emitida" nao achava nada.
alter table nfce_notas
  add column if not exists comanda_id uuid references comandas(id) on delete set null;

create index if not exists nfce_notas_comanda_idx on nfce_notas(comanda_id);

-- Uma venda, uma nota autorizada — valendo pros dois caminhos.
create unique index if not exists nfce_notas_comanda_autorizada_idx
  on nfce_notas(comanda_id) where comanda_id is not null and status = 'autorizada';

comment on column nfce_notas.comanda_id is
  'Comanda de mesa que gerou a nota. Ou isto ou pedido_id, nunca os dois.';
