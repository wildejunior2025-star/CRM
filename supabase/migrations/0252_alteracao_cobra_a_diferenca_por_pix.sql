-- =========================================================
-- 0252: pedido já pago + item a mais = PIX da diferença, ANTES da loja saber
-- =========================================================
-- A 0251 foi uma trava: somar item em pedido pago online ficou bloqueado porque
-- a cobrança da diferença não existia. Aqui ela nasce, e a trava sai.
--
-- O buraco que a trava tapava (teste do #1076, 09/09/2026): o cliente somou
-- R$ 119,60 num pedido de R$ 0,50 já pago, e a mudança chegou na loja como
-- qualquer outra. Aceitando, a loja ficava com a mercadoria pra cobrar na porta.
--
-- A decisão do dono é cobrar NA HORA e estornar se a loja recusar -- "é melhor
-- que pagar depois e a pessoa não pagar". Então:
--
--   cliente soma item  ->  status 'aguardando_pagamento' (a loja NÃO vê)
--   paga o PIX         ->  webhook chama confirmar_pagamento_alteracao()
--                          -> vira 'pendente' e aí sim a campainha toca
--   loja recusa        ->  estorna aquele pagamento inteiro, sem encostar
--                          no dinheiro do pedido original
--
-- O gestor lista só 'pendente'. É isso que faz a alteração não paga ser
-- invisível pra loja -- e o teste confirmou: forçando o aceite direto no banco,
-- decidir_alteracao_pedido devolve 'aguardando_pagamento' e não aplica nada.
--
-- Não entra aqui, de propósito:
--   * TIRAR item de pedido pago -- ali o dinheiro volta (estorno parcial, 0250)
--   * pedido que se paga na entrega -- o motoboy cobra o valor novo
-- =========================================================

ALTER TABLE public.pedido_alteracoes
  ADD COLUMN IF NOT EXISTS valor_a_pagar  numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mp_payment_id  text,
  ADD COLUMN IF NOT EXISTS pix_qr         text,
  ADD COLUMN IF NOT EXISTS pix_qr_base64  text,
  ADD COLUMN IF NOT EXISTS pago_em        timestamptz;

ALTER TABLE public.pedido_alteracoes DROP CONSTRAINT IF EXISTS pedido_alteracoes_status_check;
ALTER TABLE public.pedido_alteracoes ADD CONSTRAINT pedido_alteracoes_status_check
  CHECK (status IN ('aguardando_pagamento', 'pendente', 'aceita', 'recusada', 'expirada'));

CREATE INDEX IF NOT EXISTS pedido_alteracoes_mp_payment
  ON public.pedido_alteracoes (mp_payment_id) WHERE mp_payment_id IS NOT NULL;

-- Uma viva por pedido: esperando pagamento também segura a fila, senão o
-- cliente gera cinco QR codes do mesmo pedido.
DROP INDEX IF EXISTS pedido_alteracoes_uma_pendente;
CREATE UNIQUE INDEX IF NOT EXISTS pedido_alteracoes_uma_viva
  ON public.pedido_alteracoes (pedido_id) WHERE status IN ('pendente', 'aguardando_pagamento');

DROP FUNCTION IF EXISTS public.solicitar_alteracao_pedido(uuid, jsonb, numeric, numeric);

CREATE FUNCTION public.solicitar_alteracao_pedido(
  p_pedido_id uuid, p_itens jsonb, p_subtotal numeric, p_total numeric
)
RETURNS TABLE (alteracao_id uuid, situacao text, a_pagar numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ped   pedidos_delivery;
  v_id    uuid;
  v_pago  boolean;
  v_falta numeric := 0;
  v_st    text := 'pendente';
BEGIN
  SELECT * INTO v_ped FROM pedidos_delivery WHERE id = p_pedido_id;
  IF v_ped.id IS NULL THEN RAISE EXCEPTION 'Pedido não encontrado'; END IF;

  IF v_ped.origem = 'ifood' THEN
    RAISE EXCEPTION 'Pedido do iFood não pode ser alterado por aqui';
  END IF;

  IF COALESCE(v_ped.status, '') NOT IN ('aguardando', 'confirmado', 'em_preparo', 'pronto') THEN
    RAISE EXCEPTION 'Este pedido não aceita mais alteração';
  END IF;

  IF jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'Para não levar nada, cancele o pedido';
  END IF;

  IF EXISTS (SELECT 1 FROM pedido_alteracoes a
              WHERE a.pedido_id = p_pedido_id
                AND a.status IN ('pendente', 'aguardando_pagamento') AND a.expira_em > now()) THEN
    RAISE EXCEPTION 'Já existe um pedido de alteração em andamento';
  END IF;

  UPDATE pedido_alteracoes a SET status = 'expirada'
   WHERE a.pedido_id = p_pedido_id
     AND a.status IN ('pendente', 'aguardando_pagamento') AND a.expira_em <= now();

  v_pago := COALESCE(v_ped.mp_payment_status = 'approved', false)
         OR COALESCE(v_ped.pix_status = 'pago', false);
  IF v_pago AND p_total > COALESCE(v_ped.total, 0) + 0.009 THEN
    v_falta := ROUND(p_total - COALESCE(v_ped.total, 0), 2);
    v_st := 'aguardando_pagamento';
  END IF;

  INSERT INTO pedido_alteracoes (
    empresa_id, pedido_id, itens_antes, itens_depois,
    subtotal_antes, subtotal_depois, total_antes, total_depois,
    status, valor_a_pagar, expira_em
  ) VALUES (
    v_ped.empresa_id, v_ped.id, COALESCE(v_ped.itens, '[]'::jsonb), p_itens,
    COALESCE(v_ped.subtotal, 0), p_subtotal, COALESCE(v_ped.total, 0), p_total,
    v_st, v_falta,
    -- Esperando PIX ganha mais tempo: 15 min é pouco pra abrir o banco e pagar.
    now() + CASE WHEN v_st = 'aguardando_pagamento' THEN interval '30 minutes' ELSE interval '15 minutes' END
  ) RETURNING pedido_alteracoes.id INTO v_id;

  RETURN QUERY SELECT v_id, v_st, v_falta;
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_alteracao_pedido(uuid, jsonb, numeric, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.solicitar_alteracao_pedido(uuid, jsonb, numeric, numeric) TO anon, authenticated;

-- O PIX da diferença caiu: a alteração passa a existir pra loja.
-- Chamada pelo webhook do Mercado Pago.
CREATE OR REPLACE FUNCTION public.confirmar_pagamento_alteracao(p_mp_payment_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_alt pedido_alteracoes;
BEGIN
  SELECT * INTO v_alt FROM pedido_alteracoes
   WHERE mp_payment_id = p_mp_payment_id FOR UPDATE;
  IF v_alt.id IS NULL THEN RETURN 'nao_e_alteracao'; END IF;
  IF v_alt.status <> 'aguardando_pagamento' THEN RETURN v_alt.status; END IF;

  -- Pagou depois de vencer: o dinheiro entrou e a loja não vai mais ver. Fica
  -- 'expirada' de propósito -- quem devolve é o estorno, não um aceite atrasado
  -- de uma alteração que a loja nem soube que existia.
  IF v_alt.expira_em <= now() THEN
    UPDATE pedido_alteracoes SET status = 'expirada', pago_em = now() WHERE id = v_alt.id;
    RETURN 'expirada';
  END IF;

  UPDATE pedido_alteracoes
     SET status = 'pendente', pago_em = now(),
         -- O relógio da LOJA começa agora: os 30 min de antes eram pra ele pagar.
         expira_em = now() + interval '15 minutes'
   WHERE id = v_alt.id;
  RETURN 'pendente';
END;
$$;
