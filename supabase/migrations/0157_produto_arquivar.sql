-- 0157_produto_arquivar.sql
-- Produto que já foi vendido não pode ser APAGADO — agora ele é ARQUIVADO.
--
-- O problema (Estação do Sabor, 11/08/2026): ao excluir um item do cardápio a tela
-- cuspia "update or delete on table produtos violates foreign key constraint
-- venda_itens_produto_id_fkey". O banco está certo em travar: `venda_itens` guarda
-- o que foi vendido em cada venda, e apagar o produto apagaria (ou quebraria) o
-- item dentro de vendas antigas — faturamento, relatório de produto vendido e a
-- conta impressa do cliente. `venda_itens` é a ÚNICA tabela que trava; casco,
-- estoque, ficha técnica e complementos já limpam ou soltam sozinhos.
--
-- Solução: arquivar. O item some da lista de produtos e de tudo que vende, mas a
-- linha continua no banco segurando o histórico. Dá pra desarquivar depois.
--
-- Arquivar também põe `ativo = false`, então TODA tela que já filtra `ativo = true`
-- (delivery, cardápio público, catálogo do bot, ficha técnica, consumo de
-- funcionário, estoque) esconde o item automaticamente — sem precisar mexer nelas.

ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS arquivado_em timestamptz;

COMMENT ON COLUMN public.produtos.arquivado_em IS
  'Preenchido quando o produto sai do cardápio mas não pode ser apagado (já foi vendido). NULL = produto normal.';

-- A lista de produtos filtra por este campo; o índice parcial mantém a leitura
-- barata mesmo com o cardápio grande.
CREATE INDEX IF NOT EXISTS produtos_nao_arquivados_idx
  ON public.produtos (empresa_id, nome)
  WHERE arquivado_em IS NULL;

NOTIFY pgrst, 'reload schema';
