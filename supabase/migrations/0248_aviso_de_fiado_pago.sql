-- 0248_aviso_de_fiado_pago.sql
-- "Recebemos seu pagamento" — o outro lado do aviso de fiado.
--
-- Quando a conta fecha no fiado o cliente já recebe a comanda no WhatsApp
-- (notif_fiado_compra). Mas quando ele vai lá e PAGA, não recebia nada: a loja
-- dava baixa e ele ficava sem nenhum comprovante de que a dívida foi quitada.
-- É justamente a hora em que o comprovante vale mais — some a dúvida de "será
-- que deram baixa?" e o cliente sai com a conta zerada por escrito.
--
-- Interruptor separado do de compra, e desligado por padrão: no WhatsApp
-- oficial da Meta cada aviso fora da janela de 24h é cobrado da loja. Quem
-- quiser liga em WhatsApp → Avisos.
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS notif_fiado_pago boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.whatsapp_config.notif_fiado_pago IS
  'Avisar o cliente no WhatsApp quando o fiado dele for pago (baixa na tela do Fiado ou PIX pelo link).';

-- Fiado se paga de dois jeitos: a atendente registrando em Financeiro → Fiado,
-- e o cliente pagando no PIX pelo link (confirmar_pix_fiado, disparado pelo
-- webhook do Mercado Pago). Os dois gravam a MESMA linha em `pagamentos`, com
-- observacao 'Recebimento de fiado' e sem venda_id.
--
-- Por isso o gatilho fica aqui, no pagamento, e não nas duas telas: um lugar só,
-- e qualquer caminho novo de baixa já nasce avisando.
CREATE OR REPLACE FUNCTION public.notificar_fiado_pago_no_whatsapp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  supabase_url TEXT;
  auth_key     TEXT;
BEGIN
  -- Só recebimento de fiado. Pagamento de mesa tem venda_id e outra observação;
  -- mandar "recebemos seu pagamento" pra quem pagou o almoço na hora é barulho.
  IF NEW.cliente_id IS NULL
     OR NEW.venda_id IS NOT NULL
     OR NEW.observacao IS DISTINCT FROM 'Recebimento de fiado'
     OR COALESCE(NEW.valor, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT valor INTO supabase_url FROM config_global WHERE chave = 'supabase_url'  LIMIT 1;
  SELECT valor INTO auth_key     FROM config_global WHERE chave = 'edge_auth_key' LIMIT 1;
  supabase_url := COALESCE(supabase_url, 'https://ycytrsqdvrviihkqfvno.supabase.co');

  IF COALESCE(auth_key, '') = '' THEN
    RAISE WARNING '[fiado] sem edge_auth_key em config_global — recibo do pagamento % nao foi enviado', NEW.id;
    RETURN NEW;
  END IF;

  -- net.http_post é assíncrono: entra na fila e sai DEPOIS do commit. É o que
  -- garante que a view clientes_saldo_fiado já esteja com o saldo novo quando a
  -- função for decidir entre "quitado" e "ainda falta tanto" — e é o que impede
  -- o WhatsApp de segurar a baixa se o servidor de mensagem estiver lento.
  PERFORM net.http_post(
    url     := supabase_url || '/functions/v1/fiado-pago-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || auth_key
    ),
    body    := jsonb_build_object(
      'cliente_id', NEW.cliente_id,
      'empresa_id', NEW.empresa_id,
      'valor',      NEW.valor
    )
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_fiado_pago_whatsapp ON public.pagamentos;
CREATE TRIGGER trg_fiado_pago_whatsapp
  AFTER INSERT ON public.pagamentos
  FOR EACH ROW EXECUTE FUNCTION public.notificar_fiado_pago_no_whatsapp();

-- A Estação do Sabor é quem pediu: já liga pra ela.
UPDATE public.whatsapp_config SET notif_fiado_pago = true
 WHERE empresa_id = '39c20133-3272-4ee5-add3-7a54895d4f29';
