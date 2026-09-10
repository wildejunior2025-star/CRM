-- =========================================================
-- 0251: pedido já pago online não aceita alteração que AUMENTE o valor
-- =========================================================
-- Buraco achado no teste do #1076 (09/09/2026): o cliente somou um item de
-- R$ 119,60 num pedido de R$ 0,50 já pago pelo PIX, e a mudança chegou na loja
-- como qualquer outra. Aceitando, a loja ficava com a mercadoria pra cobrar na
-- porta — e a decisão do dono era o contrário: cobrar a diferença NA HORA, e
-- estornar se a loja recusasse ("é melhor que pagar depois e a pessoa não
-- pagar").
--
-- A cobrança da diferença ainda não existe. Enquanto ela não existe, somar item
-- em pedido pago online fica bloqueado — é a trava, não a solução.
--
-- Duas coisas continuam liberadas de propósito:
--   * TIRAR item de pedido pago: ali o dinheiro volta (estorno parcial, 0250),
--     não falta.
--   * Somar em pedido que se paga na entrega: o motoboy cobra o valor novo, e
--     é assim que o dono pediu.
-- =========================================================

CREATE OR REPLACE FUNCTION public.solicitar_alteracao_pedido(
  p_pedido_id uuid, p_itens jsonb, p_subtotal numeric, p_total numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ped pedidos_delivery;
  v_id  uuid;
  v_pago_online boolean;
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

  v_pago_online := COALESCE(v_ped.mp_payment_status = 'approved', false)
                OR COALESCE(v_ped.pix_status = 'pago', false);
  IF v_pago_online AND p_total > COALESCE(v_ped.total, 0) + 0.009 THEN
    RAISE EXCEPTION 'Este pedido já está pago. Para somar itens, faça um pedido novo ou fale com a loja.';
  END IF;

  IF EXISTS (SELECT 1 FROM pedido_alteracoes
              WHERE pedido_id = p_pedido_id AND status = 'pendente' AND expira_em > now()) THEN
    RAISE EXCEPTION 'Já existe um pedido de alteração esperando a loja responder';
  END IF;

  UPDATE pedido_alteracoes SET status = 'expirada'
   WHERE pedido_id = p_pedido_id AND status = 'pendente' AND expira_em <= now();

  INSERT INTO pedido_alteracoes (
    empresa_id, pedido_id, itens_antes, itens_depois,
    subtotal_antes, subtotal_depois, total_antes, total_depois, expira_em
  ) VALUES (
    v_ped.empresa_id, v_ped.id, COALESCE(v_ped.itens, '[]'::jsonb), p_itens,
    COALESCE(v_ped.subtotal, 0), p_subtotal, COALESCE(v_ped.total, 0), p_total,
    now() + interval '15 minutes'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
