-- 0455 — O link de indicacao nunca sai pra fora da loja
--
-- 16/11/2026. A Iris pediu na Sorveteria CDBom pelo app. Quando o pedido foi
-- dado como entregue, o aviso do WhatsApp mandou o "Indique e ganhe 5%" com um
-- link /c/<token> que, ao abrir, dizia:
--
--     "A loja nao esta usando o link do cliente agora."
--
-- Nao era a CDBom que estava desligada: o token era de OUTRA loja. O app
-- montava o pedido com o cadastro que a pessoa tinha em qualquer loja
-- (PortalLoja buscava clientes so por user_id), e o dela era do Zebu, que tem
-- o link do cliente desligado. A tela ja foi corrigida, mas a raiz tem que
-- morrer aqui tambem: nenhum caminho novo pode mandar o cliente de uma loja
-- pra conta de outra. Fosse outra pessoa no lugar da Iris, o link abriria a
-- conta e o saldo de um estranho.
--
-- Duas travas:
--   1) o token so sai se o cliente for MESMO da loja do pedido;
--   2) o token so sai se a loja estiver usando o link do cliente — senao e um
--      link que o proprio sistema recusa abrir.
-- A fidelidade continua valendo nos dois casos: o cliente ganha o cashback,
-- so nao recebe um endereco que nao funciona.

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
  v_token text;
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

  -- Ganhou nesta compra? So conta a indicacao ja quitada em que ele e o
  -- indicado - o cashback so existe na primeira compra.
  SELECT COALESCE(credito_indicado, 0) INTO v_ganhou
  FROM indicacoes
  WHERE empresa_id = v_ped.empresa_id AND indicado_id = v_cli.id AND status = 'pago';

  -- O token so vai embora se a conta for desta loja e a loja usar o link.
  v_token := CASE
    WHEN v_cli.empresa_id = v_ped.empresa_id
     AND COALESCE(v_emp.link_cliente_ativo, false)
    THEN v_cli.token
  END;

  RETURN json_build_object(
    'ativo',         true,
    'ganhou',        COALESCE(v_ganhou, 0),
    'saldo',         COALESCE((SELECT saldo FROM creditos_cliente
                                WHERE empresa_id = v_ped.empresa_id AND cliente_id = v_cli.id), 0),
    'token',         v_token,
    'slug',          v_emp.slug,
    'pct_indicacao', v_cfg.pct_indicacao
  );
END;
$function$;
