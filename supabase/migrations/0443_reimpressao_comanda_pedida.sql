-- Reimpressao da comanda da cozinha pedida de um aparelho sem a termica (garcom no celular dele).
-- {em: timestamptz iso, ids: [uuid de comanda_itens]}. Quem tem a termica (Painel aberto) tira o papel.
alter table public.comandas add column if not exists reimpressao_pedida jsonb;
comment on column public.comandas.reimpressao_pedida is 'Pedido de reimpressao da comanda: {em, ids}. O Painel com impressora imprime os itens.';
