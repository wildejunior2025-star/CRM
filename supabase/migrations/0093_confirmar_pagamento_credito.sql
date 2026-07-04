-- Confirma um pagamento de crédito do bot de forma ATÔMICA:
-- saldo + histórico + status='pago' numa transação só. Idempotente pela trava
-- status='pendente' + FOR UPDATE (nunca credita 2x, nunca fica pago sem creditar).
--
-- Contexto: o webhook/reconciliação faziam isso em 2 passos (marcava 'pago' e
-- depois creditava). Se o crédito falhava (ex.: tipo 'compra_pix' inválido na
-- trava de whatsapp_credito_historico, que só aceita 'recarga_pix'), ficava
-- 'pago' sem creditar e não reprocessava. Esta função resolve os dois problemas.
CREATE OR REPLACE FUNCTION public.confirmar_pagamento_credito(p_mp_payment_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_pag public.whatsapp_credito_pagamentos%ROWTYPE;
BEGIN
  SELECT * INTO v_pag
  FROM public.whatsapp_credito_pagamentos
  WHERE mp_payment_id = p_mp_payment_id AND status = 'pendente'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;  -- já processado ou inexistente
  END IF;

  UPDATE public.empresas
  SET whatsapp_creditos = COALESCE(whatsapp_creditos, 0) + v_pag.creditos
  WHERE id = v_pag.empresa_id;

  INSERT INTO public.whatsapp_credito_historico
    (empresa_id, tipo, creditos, valor_reais, mp_payment_id, descricao)
  VALUES
    (v_pag.empresa_id, 'recarga_pix', v_pag.creditos, v_pag.valor_reais, p_mp_payment_id, 'Recarga via PIX');

  UPDATE public.whatsapp_credito_pagamentos
  SET status = 'pago'
  WHERE id = v_pag.id;

  RETURN true;
END;
$function$;
