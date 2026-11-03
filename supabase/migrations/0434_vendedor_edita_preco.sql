-- VENDEDOR MUDA O PREÇO DO ITEM NA COMANDA (03/11/2026)
--
-- Só o admin tinha o botão de digitar outro preço no item (açaí no peso,
-- salgado avulso...). A Estação do Sabor trocou o login do caixa de admin pra
-- vendedor e pediu pra continuar mexendo no preço. É uma chave POR LOJA e nasce
-- desligada: loja que não ligar não muda em nada.
--
-- A trava é só de tela, como a do admin: a RLS de comanda_itens já deixa
-- qualquer usuário da loja editar (comanda_itens_admin_all é por empresa).

alter table public.empresas
  add column if not exists vendedor_edita_preco boolean not null default false;

comment on column public.empresas.vendedor_edita_preco is
  'Vendedor pode digitar outro preço no item da comanda (presencial). Admin sempre pode.';

-- Estação do Sabor pediu.
update public.empresas set vendedor_edita_preco = true
 where id = '39c20133-3272-4ee5-add3-7a54895d4f29';
