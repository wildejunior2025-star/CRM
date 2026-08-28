-- =========================================================
-- 0200: grupo de complemento onde o cliente diz QUANTO de cada opção
-- =========================================================
-- Nasceu da CD Bom, que vende picolé no atacado. O cliente não quer "um picolé
-- sabor uva": ele quer "500 de leite condensado e 100 de uva". Até aqui o grupo
-- só sabia marcar/desmarcar dentro de um teto (`max`), então o pedido de verdade
-- não cabia na tela.
--
-- Ligado o modo:
--   • cada opção ganha quantidade própria, sem teto (o `max` deixa de valer)
--   • o `min` passa a ser lido como QUANTIDADE MÍNIMA TOTAL do grupo, não como
--     "quantas opções diferentes" — casa com o "a partir de 10 unidades" da loja
--   • a quantidade do item no pedido vira a SOMA das quantidades escolhidas, que
--     é o que dá baixa de estoque certa (mover_estoque_pedido_delivery, 0155)
--
-- Default false: todo grupo que já existe (quentinha, pizza, borda) segue
-- funcionando exatamente como antes.
--
-- Vale na Loja Online. Balcão, mesa e o robô do WhatsApp continuam no modo de
-- marcar opção — o robô, aliás, nunca leu essas regras (monta preço por conta).
-- =========================================================

ALTER TABLE public.complemento_grupos
  ADD COLUMN IF NOT EXISTS modo_quantidade boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.complemento_grupos.modo_quantidade IS
  'true = cliente escolhe a quantidade de cada opção (sem teto); o `min` vira a quantidade mínima total do grupo e o `max` é ignorado.';
