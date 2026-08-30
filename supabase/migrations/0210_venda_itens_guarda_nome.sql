-- Excluir produto passa a ser excluir mesmo.
--
-- Hoje o sistema recusa apagar um produto que já foi vendido e oferece arquivar.
-- O motivo é real: `venda_itens` guarda só o produto_id, e o nome do item sai de
-- um join com `produtos`. Apagando o produto, a venda antiga ficaria sem nome —
-- relatório e conta do cliente mostrariam uma linha em branco.
--
-- A saída não é proibir a exclusão, é a venda guardar o que vendeu. É assim que
-- `comanda_itens` sempre funcionou (tem nome e preco_unitario dentro dela), e é
-- assim que uma nota fiscal funciona: o papel não deixa de valer porque o produto
-- saiu do cardápio.
--
-- Depois disto: apagar o produto some com ele de todo canto, e o histórico
-- continua legível — a venda antiga mostra o nome que tinha na hora da venda,
-- inclusive se o produto for recriado depois com outro nome ou outro preço.

alter table venda_itens add column if not exists nome_produto text;
alter table venda_itens add column if not exists categoria_produto text;

comment on column venda_itens.nome_produto is
  'Nome do produto NA HORA DA VENDA. É o que sustenta o histórico quando o produto é excluído (ou renomeado) depois.';

-- Backfill: o que já está gravado ganha o nome de agora, que é o mais próximo
-- possível do que era na venda.
update venda_itens vi
set nome_produto = p.nome, categoria_produto = p.categoria
from produtos p
where vi.produto_id = p.id and vi.nome_produto is null;

-- Preenche sozinho daqui pra frente: nenhuma tela precisa lembrar de mandar o
-- nome, e quem já grava venda_itens hoje continua igual.
create or replace function fn_venda_item_guarda_nome()
returns trigger
language plpgsql
set search_path = public
as $$
BEGIN
  IF NEW.nome_produto IS NULL AND NEW.produto_id IS NOT NULL THEN
    SELECT nome, categoria INTO NEW.nome_produto, NEW.categoria_produto
    FROM produtos WHERE id = NEW.produto_id;
  END IF;
  RETURN NEW;
END;
$$;

drop trigger if exists trg_venda_item_guarda_nome on venda_itens;
create trigger trg_venda_item_guarda_nome
  before insert on venda_itens
  for each row execute function fn_venda_item_guarda_nome();

-- Com o nome guardado, a venda não depende mais do produto existir: a FK deixa
-- de barrar a exclusão e o produto_id vira nulo na linha antiga.
alter table venda_itens drop constraint if exists venda_itens_produto_id_fkey;
alter table venda_itens
  add constraint venda_itens_produto_id_fkey
  foreign key (produto_id) references produtos (id) on delete set null;

-- O SET NULL acima só funciona com a coluna aceitando nulo — sem isto o delete
-- morre com "null value in column produto_id". Produto nulo é justamente o
-- estado de um item cujo produto foi excluído: o que a linha precisa (nome,
-- preço, quantidade) está guardado nela mesma.
alter table venda_itens alter column produto_id drop not null;
