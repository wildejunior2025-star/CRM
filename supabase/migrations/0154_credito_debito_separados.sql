-- =========================================================
-- 0154: cartão vira DUAS formas — crédito e débito
-- =========================================================
-- A maquineta cobra taxa diferente pra cada uma (Wilde, 10/08/2026), então
-- "cartão" sozinho não deixa saber quanto cai na conta de verdade.
--
-- Agora existem 'credito' e 'debito' ao lado de 'cartao'. O 'cartao' continua
-- valendo: e o que esta gravado no historico (nao da pra adivinhar depois se
-- aquela venda foi credito ou debito), e serve pra loja que nao quer separar.
--
-- recebimentos_cartao na view passa a ser a SOMA dos tres, entao tudo que ja
-- mostrava "recebido em cartao" continua certo sem mexer em nada.
-- =========================================================

-- ── Taxa por forma ──────────────────────────────────────────────────────
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS taxa_credito_pct numeric NOT NULL DEFAULT 0;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS taxa_debito_pct  numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN empresas.taxa_credito_pct IS 'Taxa da maquineta no crédito, em % (ex.: 3.5).';
COMMENT ON COLUMN empresas.taxa_debito_pct  IS 'Taxa da maquineta no débito, em % (ex.: 1.5).';

-- Quem já tinha posto a taxa genérica de cartão herda ela nas duas (é o palpite
-- certo: era a taxa que ele conhecia). Depois ele ajusta cada uma.
UPDATE empresas
   SET taxa_credito_pct = taxa_cartao_pct,
       taxa_debito_pct  = taxa_cartao_pct
 WHERE taxa_cartao_pct > 0 AND taxa_credito_pct = 0 AND taxa_debito_pct = 0;

-- ── View do caixa: separa crédito e débito ──────────────────────────────
-- As colunas antigas ficam na MESMA ordem (CREATE OR REPLACE exige) e as novas
-- entram no fim.
CREATE OR REPLACE VIEW public.caixa_resumo AS
 SELECT c.id AS caixa_id,
    COALESCE(ve.vendas_a_vista, 0::numeric) AS vendas_a_vista,
    COALESCE(ve.vendas_fiado, 0::numeric) AS vendas_fiado,
    COALESCE(ve.vendas_boleto, 0::numeric) AS vendas_boleto,
    COALESCE(pg.recebimentos_dinheiro, 0::numeric) AS recebimentos_dinheiro,
    COALESCE(pg.recebimentos_pix, 0::numeric) AS recebimentos_pix,
    COALESCE(pg.recebimentos_transferencia, 0::numeric) AS recebimentos_transferencia,
    -- Total no cartão: genérico + crédito + débito.
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
    -- Novas: o cartão aberto em crédito e débito (o resto do 'cartao' é o genérico).
    COALESCE(pg.recebimentos_credito, 0::numeric) AS recebimentos_credito,
    COALESCE(pg.recebimentos_debito, 0::numeric) AS recebimentos_debito,
    COALESCE(pg.recebimentos_cartao_generico, 0::numeric) AS recebimentos_cartao_generico,
    COALESCE(pg.recebimentos_fiado_credito, 0::numeric) AS recebimentos_fiado_credito,
    COALESCE(pg.recebimentos_fiado_debito, 0::numeric) AS recebimentos_fiado_debito
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
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text) AS recebimentos_fiado,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_fiado_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_fiado_pix,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = ANY (ARRAY['cartao'::text, 'credito'::text, 'debito'::text])) AS recebimentos_fiado_cartao,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'credito'::text) AS recebimentos_fiado_credito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'debito'::text) AS recebimentos_fiado_debito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_fiado_transferencia
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

-- ── Funções que só aceitavam a lista antiga de formas ───────────────────
-- Em vez de recolar as duas funções inteiras (200+ linhas, risco de erro de
-- transcrição), reescreve só a lista dentro da definição que já está no banco.
-- Se o trecho não existir mais, o bloco explode em vez de passar batido.
DO $mig$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.fechar_conta_presencial(uuid,jsonb,boolean,uuid)'::regprocedure);
  IF position('(''dinheiro'',''pix'',''cartao'',''transferencia'')' IN d) = 0 THEN
    RAISE EXCEPTION 'fechar_conta_presencial mudou: a lista de formas não está mais onde eu esperava';
  END IF;
  d := replace(d,
    '(''dinheiro'',''pix'',''cartao'',''transferencia'')',
    '(''dinheiro'',''pix'',''cartao'',''credito'',''debito'',''transferencia'')');
  EXECUTE d;
END $mig$;

DO $mig$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.alterar_forma_pagamento_comanda(uuid,text)'::regprocedure);
  IF position('(''dinheiro'',''pix'',''cartao'',''fiado'')' IN d) = 0 THEN
    RAISE EXCEPTION 'alterar_forma_pagamento_comanda mudou: a lista de formas não está mais onde eu esperava';
  END IF;
  d := replace(d,
    '(''dinheiro'',''pix'',''cartao'',''fiado'')',
    '(''dinheiro'',''pix'',''cartao'',''credito'',''debito'',''fiado'')');
  d := replace(d,
    'Forma inválida. Use dinheiro, pix, cartão ou fiado.',
    'Forma inválida. Use dinheiro, pix, crédito, débito, cartão ou fiado.');
  EXECUTE d;
END $mig$;
