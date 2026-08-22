-- O que dizer pro cliente quando o pedido dele conclui.
--
-- Serve dois lugares com a MESMA resposta: a tela de acompanhamento do pedido e
-- a mensagem do WhatsApp. Se cada um montasse a sua, um dia iam divergir e o
-- cliente veria um valor na tela e outro no zap.
--
-- Devolve duas coisas diferentes:
--   ganhou → só quando ESTE pedido pagou o cashback da indicação dele
--   token  → sempre que o programa está ligado, pra convidar qualquer comprador
--            a indicar. É o que resolve a divulgação: sem isso o cliente só
--            descobre que tem um link se o lojista mandar um por um, e o
--            programa nunca sai do lugar.
CREATE OR REPLACE FUNCTION public.pedido_cashback(p_pedido_id uuid)
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ped  pedidos_delivery%ROWTYPE;
  v_cli  clientes%ROWTYPE;
  v_cfg  fidelidade_config%ROWTYPE;
  v_emp  empresas%ROWTYPE;
  v_ganhou numeric := 0;
BEGIN
  SELECT * INTO v_ped FROM pedidos_delivery WHERE id = p_pedido_id;
  IF v_ped.id IS NULL OR v_ped.cliente_id IS NULL THEN
    RETURN json_build_object('ativo', false);
  END IF;

  SELECT * INTO v_cfg FROM fidelidade_config WHERE empresa_id = v_ped.empresa_id;
  IF v_cfg.empresa_id IS NULL OR NOT v_cfg.ativo THEN
    RETURN json_build_object('ativo', false);
  END IF;

  SELECT * INTO v_cli FROM clientes WHERE id = v_ped.cliente_id;
  IF v_cli.id IS NULL THEN RETURN json_build_object('ativo', false); END IF;

  SELECT * INTO v_emp FROM empresas WHERE id = v_ped.empresa_id;

  -- Ganhou nesta compra? Só conta a indicação já quitada em que ele é o
  -- indicado — o cashback só existe na primeira compra.
  SELECT COALESCE(credito_indicado, 0) INTO v_ganhou
  FROM indicacoes
  WHERE empresa_id = v_ped.empresa_id AND indicado_id = v_cli.id AND status = 'pago';

  RETURN json_build_object(
    'ativo',         true,
    'ganhou',        COALESCE(v_ganhou, 0),
    'saldo',         COALESCE((SELECT saldo FROM creditos_cliente
                                WHERE empresa_id = v_ped.empresa_id AND cliente_id = v_cli.id), 0),
    'token',         v_cli.token,
    'slug',          v_emp.slug,
    'pct_indicacao', v_cfg.pct_indicacao
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.pedido_cashback(uuid) FROM public;
GRANT  EXECUTE ON FUNCTION public.pedido_cashback(uuid) TO anon, authenticated;
