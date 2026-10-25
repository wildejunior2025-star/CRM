-- ─────────────────────────────────────────────────────────────────────────────
-- 0391 — "Pedido PRONTO" também avisa o cliente
--
-- O Braseiro, 24/10/2026, 23h: o pedido #1024 (retirada) foi marcado pronto e o
-- cliente ficou perguntando "ja ta pronto?" no WhatsApp. A loja achou que o
-- sistema tinha avisado. Não tinha — e o mesmo aconteceu com o #1025.
--
-- Na trilha do pedido #1024 saíram os avisos `confirmado` e `entregue`. O
-- `pronto` não saiu porque ele NUNCA ESTEVE na lista deste gatilho.
--
-- E por que a correção anterior (na edge function, que já sabe escrever
-- "pronto para retirada") não resolveu: ela nunca é chamada pra esse status.
-- Quem marca pronto na COZINHA grava direto em pedidos_delivery, sem passar
-- pelo painel — e era só o painel que chamava a função pela tela.
--
-- SEGUNDA VEZ QUE ISSO É CORRIGIDO, então vai na camada que cobre todo mundo:
-- cozinha, painel, app do entregador, iFood e qualquer automação futura. Papel
-- de tela só vale pra quem passa por aquela tela.
--
-- Mandar duas vezes não é risco: a edge function tem trava de duplicata
-- (`whatsapp_notify_dedup`), e na retirada a chave é do RECADO
-- (`pedido:pronto-retirada`), então `pronto` e `saiu_entrega` contam como o
-- mesmo aviso. Quem chegar depois leva erro de chave repetida e sai fora.
--
-- Entrega (não retirada) continua sem mensagem no `pronto`: a edge function
-- decide isso, e lá a regra é avisar só no despacho — "ficou pronto" e logo
-- depois "saiu pra entrega" é mensagem demais pra mesma comida.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.notify_whatsapp_status_change()
returns trigger
language plpgsql
as $function$
DECLARE
  notify_statuses TEXT[] := ARRAY['confirmado','em_preparo','pronto','saiu_entrega','entregue','cancelado'];
  supabase_url TEXT;
  auth_key     TEXT;
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = ANY(notify_statuses) THEN
    SELECT valor INTO supabase_url FROM config_global WHERE chave = 'supabase_url'   LIMIT 1;
    SELECT valor INTO auth_key     FROM config_global WHERE chave = 'edge_auth_key'  LIMIT 1;

    supabase_url := COALESCE(supabase_url, 'https://ycytrsqdvrviihkqfvno.supabase.co');

    IF COALESCE(auth_key, '') = '' THEN
      RAISE WARNING '[notify] sem edge_auth_key em config_global — aviso do pedido % (%) nao foi enviado', NEW.id, NEW.status;
      RETURN NEW;
    END IF;

    PERFORM net.http_post(
      url     := supabase_url || '/functions/v1/whatsapp-pedido-notify',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || auth_key
      ),
      body    := jsonb_build_object(
        'pedido_id',   NEW.id,
        'novo_status', NEW.status
      )
    );
  END IF;
  RETURN NEW;
END;
$function$;
