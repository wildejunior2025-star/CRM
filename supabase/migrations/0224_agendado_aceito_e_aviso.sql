-- =========================================================
-- 0224: pedido agendado entra ACEITO e avisa a loja no WhatsApp
-- =========================================================
-- Duas coisas que o primeiro dia de agendamento (02/09/2026) mostrou:
--
-- 1) Esperando aceite, o agendado MORRE. O painel dá 6 minutos pra loja
--    clicar em Confirmar e, passado o prazo, cancela sozinho. Só que o
--    agendado nasce justamente com a loja fechada: não tem ninguém pra
--    clicar. E não faz sentido cobrar decisão na hora — sobra tempo de sobra
--    pra ver o pedido, trocar item ou cancelar antes da hora combinada.
--
-- 2) A loja não fica sabendo. Gestor fechado, ninguém no painel: ela só
--    descobre o pedido quando abre. O aviso sai pelo WhatsApp da FWC (mesmo
--    caminho do alerta de estoque), não pelo número da loja — ver a edge
--    function pedido-agendado-alerta.
-- =========================================================

-- 1) Agendado já entra aceito ------------------------------------------------
CREATE OR REPLACE FUNCTION public.agendado_entra_aceito()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Só o agendado. Pedido pra agora continua passando pelo aceite normal.
  IF NEW.agendado_para IS NOT NULL AND NEW.status = 'aguardando' THEN
    NEW.status := 'confirmado';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agendado_entra_aceito ON public.pedidos_delivery;
CREATE TRIGGER trg_agendado_entra_aceito
  BEFORE INSERT OR UPDATE OF status ON public.pedidos_delivery
  FOR EACH ROW
  EXECUTE FUNCTION public.agendado_entra_aceito();

-- 2) Aviso pra loja ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.avisar_pedido_agendado()
RETURNS trigger
LANGUAGE plpgsql
-- security definer: config_global tem RLS de super_admin e o gatilho roda no
-- papel de quem fez o pedido (o cliente anônimo da Loja Online). Sem isto a
-- chave volta vazia e nenhum aviso sai.
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  supabase_url TEXT;
  auth_key     TEXT;
BEGIN
  IF NEW.agendado_para IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IN ('cancelado', 'aguardando_pagamento') THEN RETURN NEW; END IF;

  -- Uma vez só por pedido: no INSERT, ou quando o PIX é confirmado (o pedido
  -- nasce em aguardando_pagamento e só depois vira pedido de verdade).
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'aguardando_pagamento' THEN
    RETURN NEW;
  END IF;

  SELECT valor INTO supabase_url FROM config_global WHERE chave = 'supabase_url'  LIMIT 1;
  SELECT valor INTO auth_key     FROM config_global WHERE chave = 'edge_auth_key' LIMIT 1;
  supabase_url := COALESCE(supabase_url, 'https://ycytrsqdvrviihkqfvno.supabase.co');

  IF COALESCE(auth_key, '') = '' THEN
    RAISE WARNING '[agendado] sem edge_auth_key em config_global — pedido % sem aviso', NEW.id;
    RETURN NEW;
  END IF;

  -- Assíncrono (sai depois do commit): o WhatsApp não pode segurar o checkout
  -- do cliente se o servidor de mensagem estiver lento.
  PERFORM net.http_post(
    url     := supabase_url || '/functions/v1/pedido-agendado-alerta',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || auth_key
    ),
    body    := jsonb_build_object('pedido_id', NEW.id)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_avisar_pedido_agendado ON public.pedidos_delivery;
CREATE TRIGGER trg_avisar_pedido_agendado
  AFTER INSERT OR UPDATE OF status ON public.pedidos_delivery
  FOR EACH ROW
  EXECUTE FUNCTION public.avisar_pedido_agendado();
