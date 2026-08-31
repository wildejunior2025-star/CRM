-- =========================================================
-- 0214: a comanda do FIADO vai pro WhatsApp do cliente na hora
-- =========================================================
-- Fiado gera discussão. Dias depois o cliente diz que não comprou aquilo, e não
-- tem como saber se ele esqueceu ou se a atendente anotou na conta errada —
-- ninguém lembra de um almoço de duas semanas atrás. Na Estação do Sabor isso
-- virou rotina (agosto/2026).
--
-- Mandar a comanda NO DIA resolve os dois lados: o cliente confere com a
-- memória fresca e a loja fica com a prova de que avisou. Se a anotação estava
-- errada, dá pra corrigir enquanto ainda é fácil.
--
-- Só FIADO. Dinheiro, PIX e cartão o cliente já pagou e foi embora: mandar
-- comprovante do que ele quitou é só barulho no WhatsApp dele.
--
-- Vem DESLIGADO em todas as lojas. Mensagem automática pra cliente é decisão de
-- cada dono, não padrão do sistema.
-- =========================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS notif_fiado_compra boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.whatsapp_config.notif_fiado_compra IS
  'Manda a comanda no WhatsApp do cliente quando a conta é fechada no fiado. Desligado por padrão.';

-- O gatilho fica na VENDA, não na tela. A conta é fechada por três caminhos
-- (ADM no PC, garçom pelo celular, ADM conferindo depois no painel) e todos
-- terminam na mesma função do banco: pendurar isso em cada tela deixaria um
-- caminho de fora, e ninguém ia descobrir qual.
CREATE OR REPLACE FUNCTION public.notificar_fiado_no_whatsapp()
RETURNS trigger
LANGUAGE plpgsql
-- security definer pelo mesmo motivo do notify_whatsapp_status_change:
-- config_global tem RLS de super_admin e o gatilho roda no papel de quem fechou
-- a conta (o garçom). Sem isto a chave volta vazia e nenhum aviso sai.
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supabase_url TEXT;
  auth_key     TEXT;
BEGIN
  IF NEW.forma_pagamento IS DISTINCT FROM 'fiado' OR NEW.cliente_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT valor INTO supabase_url FROM config_global WHERE chave = 'supabase_url'  LIMIT 1;
  SELECT valor INTO auth_key     FROM config_global WHERE chave = 'edge_auth_key' LIMIT 1;
  supabase_url := COALESCE(supabase_url, 'https://ycytrsqdvrviihkqfvno.supabase.co');

  IF COALESCE(auth_key, '') = '' THEN
    RAISE WARNING '[fiado] sem edge_auth_key em config_global — comanda da venda % nao foi enviada', NEW.id;
    RETURN NEW;
  END IF;

  -- net.http_post é assíncrono: entra na fila e sai depois do commit. É o que
  -- garante que os venda_itens já existam quando a função for montar a mensagem
  -- — e é o que impede o WhatsApp de segurar o fechamento da conta se o
  -- servidor de mensagem estiver lento.
  PERFORM net.http_post(
    url     := supabase_url || '/functions/v1/fiado-comanda-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || auth_key
    ),
    body    := jsonb_build_object('venda_id', NEW.id)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notificar_fiado_whatsapp ON public.vendas;
CREATE TRIGGER trg_notificar_fiado_whatsapp
  AFTER INSERT ON public.vendas
  FOR EACH ROW
  EXECUTE FUNCTION public.notificar_fiado_no_whatsapp();
