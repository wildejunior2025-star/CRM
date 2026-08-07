-- 0148_caixa_separa_recebimento_fiado.sql
-- O caixa passa a mostrar quanto do dinheiro recebido é DÍVIDA ANTIGA.
--
-- O caixa somava tudo que entrou em cada forma (dinheiro/pix/cartão) sem separar
-- o que era venda do dia do que era freguês pagando fiado velho. Na hora de
-- conferir, o dono via "entrou R$ 575,00" e "vendi R$ 562,50" e não entendia a
-- diferença — que é justamente o fiado: R$ 74,50 de dívida antiga entraram no
-- caixa mas não são venda de hoje, e R$ 62,00 de fiado novo são venda de hoje
-- mas não entraram no caixa (Estação do Sabor, 07/08/2026).
--
-- O marcador é a observação 'Recebimento de fiado', gravada pela tela do Fiado
-- (ClientesFiado.receber). É a mesma que a tela usa pra listar os recebimentos —
-- se mudar lá, muda aqui.
--
-- Só ACRESCENTA `recebimentos_fiado` no fim. O resto é a definição que está no ar
-- (0115 + as colunas de sangria/suprimento por forma que vieram depois) — copiada
-- do banco, não da migration antiga, senão o CREATE OR REPLACE derruba coluna.

CREATE OR REPLACE VIEW public.caixa_resumo
WITH (security_invoker = on) AS
SELECT c.id AS caixa_id,
    COALESCE(ve.vendas_a_vista, 0::numeric) AS vendas_a_vista,
    COALESCE(ve.vendas_fiado, 0::numeric) AS vendas_fiado,
    COALESCE(ve.vendas_boleto, 0::numeric) AS vendas_boleto,
    COALESCE(pg.recebimentos_dinheiro, 0::numeric) AS recebimentos_dinheiro,
    COALESCE(pg.recebimentos_pix, 0::numeric) AS recebimentos_pix,
    COALESCE(pg.recebimentos_transferencia, 0::numeric) AS recebimentos_transferencia,
    COALESCE(pg.recebimentos_cartao, 0::numeric) AS recebimentos_cartao,
    COALESCE(mv.total_sangrias, 0::numeric) AS total_sangrias,
    COALESCE(mv.total_suprimentos, 0::numeric) AS total_suprimentos,
    COALESCE(mv.total_sangrias_dinheiro, 0::numeric) AS total_sangrias_dinheiro,
    COALESCE(mv.total_sangrias_pix, 0::numeric) AS total_sangrias_pix,
    COALESCE(mv.total_suprimentos_dinheiro, 0::numeric) AS total_suprimentos_dinheiro,
    COALESCE(mv.total_suprimentos_pix, 0::numeric) AS total_suprimentos_pix,
    -- Quanto do que entrou é freguês pagando o que já devia (não é venda de hoje).
    COALESCE(pg.recebimentos_fiado, 0::numeric) AS recebimentos_fiado
   FROM caixas c
     LEFT JOIN LATERAL ( SELECT sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'a_vista'::text AND vendas.status <> 'cancelado'::text) AS vendas_a_vista,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'fiado'::text AND vendas.status <> 'cancelado'::text) AS vendas_fiado,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento ~~ 'boleto%'::text AND vendas.status <> 'cancelado'::text) AS vendas_boleto
           FROM vendas
          WHERE vendas.caixa_id = c.id) ve ON true
     LEFT JOIN LATERAL ( SELECT sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_pix,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_transferencia,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'cartao'::text) AS recebimentos_cartao,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text) AS recebimentos_fiado
           FROM pagamentos
          WHERE pagamentos.caixa_id = c.id) pg ON true
     LEFT JOIN LATERAL ( SELECT sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text) AS total_sangrias,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text) AS total_suprimentos,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_sangrias_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'pix'::text) AS total_sangrias_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_suprimentos_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'pix'::text) AS total_suprimentos_pix
           FROM caixa_movimentos
          WHERE caixa_movimentos.caixa_id = c.id) mv ON true
  WHERE c.empresa_id = current_empresa_id();
