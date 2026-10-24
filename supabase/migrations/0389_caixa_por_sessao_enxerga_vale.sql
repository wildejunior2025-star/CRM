-- O CAIXA POR SESSAO NAO ENXERGAVA OS VALES (24/10/2026)
--
-- A mig 0388 criou Pluxee/Alelo/VR/Ticket e ensinou o caixa POR DIA
-- (caixa_resumo_do_dia) a somar o balde 'vale'. Mas a loja que fecha caixa por
-- SESSAO (abrir/fechar, que e o caso da Agv) le a view `caixa_resumo` — e essa
-- ficou pra tras.
--
-- Efeito no balcao: o Pluxee era gravado certinho em `pagamentos` e nao entrava
-- no cartao (isso a 0388 acertou), mas sumia da tela E do faturamento total. No
-- dia 24/10 a Agv recebeu R$ 61,63 em Pluxee e fechou o caixa sem eles: o total
-- mostrava R$ 1.470,18 em vez de R$ 1.531,81.
--
-- As duas colunas entram NO FIM: `create or replace view` so aceita coluna nova
-- no fim, e o front ja le os dois nomes (valeDe, em Caixa.jsx).
CREATE OR REPLACE VIEW caixa_resumo AS
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
    COALESCE(pg.recebimentos_fiado, 0::numeric) AS recebimentos_fiado,
    COALESCE(pg.recebimentos_fiado_dinheiro, 0::numeric) AS recebimentos_fiado_dinheiro,
    COALESCE(pg.recebimentos_fiado_pix, 0::numeric) AS recebimentos_fiado_pix,
    COALESCE(pg.recebimentos_fiado_cartao, 0::numeric) AS recebimentos_fiado_cartao,
    COALESCE(pg.recebimentos_fiado_transferencia, 0::numeric) AS recebimentos_fiado_transferencia,
    COALESCE(pg.recebimentos_credito, 0::numeric) AS recebimentos_credito,
    COALESCE(pg.recebimentos_debito, 0::numeric) AS recebimentos_debito,
    COALESCE(pg.recebimentos_cartao_generico, 0::numeric) AS recebimentos_cartao_generico,
    COALESCE(pg.recebimentos_fiado_credito, 0::numeric) AS recebimentos_fiado_credito,
    COALESCE(pg.recebimentos_fiado_debito, 0::numeric) AS recebimentos_fiado_debito,
    COALESCE(mv.total_sangrias_cartao, 0::numeric) AS total_sangrias_cartao,
    COALESCE(mv.total_suprimentos_cartao, 0::numeric) AS total_suprimentos_cartao,
    COALESCE(pg.recebimentos_cashback, 0::numeric) AS recebimentos_cashback,
    COALESCE(dl.delivery_pedidos, 0::bigint) AS delivery_pedidos,
    COALESCE(dl.delivery_dinheiro, 0::numeric) AS delivery_dinheiro,
    COALESCE(dl.delivery_pix, 0::numeric) AS delivery_pix,
    COALESCE(dl.delivery_cartao, 0::numeric) AS delivery_cartao,
    COALESCE(dl.delivery_online, 0::numeric) AS delivery_online,
    COALESCE(dl.delivery_ifood, 0::numeric) AS delivery_ifood,
    COALESCE(dl.delivery_outros, 0::numeric) AS delivery_outros,
    COALESCE(dl.delivery_credito, 0::numeric) AS delivery_credito,
    COALESCE(dl.delivery_debito, 0::numeric) AS delivery_debito,
    COALESCE(dl.delivery_cartao_generico, 0::numeric) AS delivery_cartao_generico,
    COALESCE(pg.recebimentos_vale, 0::numeric) AS recebimentos_vale,
    COALESCE(dl.delivery_vale, 0::numeric) AS delivery_vale
   FROM caixas c
     LEFT JOIN LATERAL ( SELECT sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'a_vista'::text AND vendas.status <> 'cancelado'::text) AS vendas_a_vista,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'fiado'::text AND vendas.status <> 'cancelado'::text) AS vendas_fiado,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento ~~ 'boleto%'::text AND vendas.status <> 'cancelado'::text) AS vendas_boleto
           FROM vendas
          WHERE vendas.caixa_id = c.id) ve ON true
     LEFT JOIN LATERAL ( SELECT sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_pix,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_transferencia,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = ANY (ARRAY['cartao'::text, 'credito'::text, 'debito'::text])) AS recebimentos_cartao,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'credito'::text) AS recebimentos_credito,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'debito'::text) AS recebimentos_debito,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'cartao'::text) AS recebimentos_cartao_generico,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'cashback'::text) AS recebimentos_cashback,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = ANY (ARRAY['pluxee'::text, 'alelo'::text, 'vr'::text, 'ticket'::text])) AS recebimentos_vale,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text) AS recebimentos_fiado,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_fiado_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_fiado_pix,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND (pagamentos.forma_pagamento = ANY (ARRAY['cartao'::text, 'credito'::text, 'debito'::text]))) AS recebimentos_fiado_cartao,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'credito'::text) AS recebimentos_fiado_credito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'debito'::text) AS recebimentos_fiado_debito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_fiado_transferencia
           FROM pagamentos
          WHERE pagamentos.caixa_id = c.id) pg ON true
     LEFT JOIN LATERAL ( SELECT sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text) AS total_sangrias,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text) AS total_suprimentos,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_sangrias_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'pix'::text) AS total_sangrias_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'cartao'::text) AS total_sangrias_cartao,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_suprimentos_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'pix'::text) AS total_suprimentos_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'cartao'::text) AS total_suprimentos_cartao
           FROM caixa_movimentos
          WHERE caixa_movimentos.caixa_id = c.id) mv ON true
     LEFT JOIN LATERAL ( SELECT count(DISTINCT dp.pedido_id) AS delivery_pedidos,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'dinheiro'::text) AS delivery_dinheiro,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'pix'::text) AS delivery_pix,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'credito'::text) AS delivery_credito,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'debito'::text) AS delivery_debito,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'cartao'::text) AS delivery_cartao_generico,
            sum(dp.valor) FILTER (WHERE dp.bucket = ANY (ARRAY['credito'::text, 'debito'::text, 'cartao'::text])) AS delivery_cartao,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'online'::text) AS delivery_online,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'ifood'::text) AS delivery_ifood,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'outros'::text) AS delivery_outros,
            sum(dp.valor) FILTER (WHERE dp.bucket = 'vale'::text) AS delivery_vale
           FROM caixa_delivery_partes dp
          WHERE dp.caixa_id = c.id) dl ON true
  WHERE c.empresa_id = current_empresa_id();
