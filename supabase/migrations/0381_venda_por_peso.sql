-- Produto vendido por QUILO, e quantidade quebrada na comanda (23/10/2026)
--
-- POR QUE EXISTE
-- O Agv Grill vende almoço no peso: o cliente monta o prato, pesa no balcão e
-- o item vai pra comanda da mesa dele, que é paga no fim. A balança é uma
-- Toledo Prix 3 Fit ligada no computador, e devolve o peso com TRÊS casas
-- (14,385 kg).
--
-- Só que a comanda guardava quantidade INTEIRA. Um prato de 0,425 kg virava 0
-- — a linha entrava na conta valendo nada. E a venda de balcão guardava duas
-- casas, então 0,425 kg viraria 0,43: vinte centavos a mais num prato de
-- R$ 40/kg, todo dia, em todo prato.
--
-- Três casas é o que a balança entrega e é o que o INMETRO exige dela (a
-- divisão dessa Prix é de 2 g, 5 g ou 10 g conforme a faixa).
--
-- CONFERIDO ANTES DE MEXER: nenhuma view depende dessas colunas, e as 20
-- funções que escrevem nelas convertem o JSON com ::numeric — nenhuma com
-- ::int, que truncaria o peso em silêncio.

alter table public.comanda_itens
  alter column quantidade type numeric(12,3) using quantidade::numeric(12,3);

alter table public.venda_itens
  alter column quantidade type numeric(12,3) using quantidade::numeric(12,3);

-- Produto vendido a peso: o `preco_venda` passa a ser o preço do QUILO, e a
-- quantidade da linha é o peso. Fica como marca no produto (e não só como um
-- jeito de digitar) porque quem precisa saber disso é a tela: ela é que decide
-- se pergunta "quantos?" ou se vai na balança.
alter table public.produtos
  add column if not exists vendido_por_peso boolean not null default false;

comment on column public.produtos.vendido_por_peso is
  'Vendido a quilo: preco_venda e o preco do KG e a quantidade da linha e o peso em kg.';
