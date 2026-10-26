-- ─────────────────────────────────────────────────────────────────────────────
-- 0396 — O aviso de status voltou a sair (o gatilho tinha perdido o crachá)
--
-- Agv, 26/10/2026: a Victoria fechou o pedido #1 pelo robô, a loja aceitou e
-- despachou em um minuto — e ela não recebeu NADA. Nem "confirmado", nem "saiu
-- para entrega".
--
-- O gatilho rodou. Ele só não conseguiu LER A CHAVE: `config_global` tem RLS e
-- a única política é de super_admin. Num gatilho SECURITY INVOKER quem lê é o
-- usuário que mexeu no pedido — o funcionário da loja, perfil `admin` —, então
-- o SELECT voltou vazio, a função caiu no `RAISE WARNING ... sem edge_auth_key`
-- e devolveu NEW sem mandar nada. Em silêncio: `net.http_post` nunca chegou a
-- ser chamado, não há erro em lugar nenhum, e pro cliente o pedido simplesmente
-- some.
--
-- Como isso entrou: a 0391 (que acrescentou o status 'pronto' à lista) usou
-- `create or replace function` sem repetir o `security definer`. O CREATE OR
-- REPLACE preserva o dono e as permissões, mas TROCA todos os outros atributos
-- — e o que não está escrito na nova definição deixa de existir. A função
-- irmã, `notify_ifood_status`, continuou `security definer` e por isso o iFood
-- seguiu avisando normalmente.
--
-- Por que ninguém viu antes: o Wilde é super_admin. Quando ELE mexe num pedido
-- pelo painel, a política passa e o aviso sai. Quando quem mexe é a loja, não.
-- Dois dias de testes com a conta errada.
--
-- Aqui: `security definer` + `search_path` fixo (sem ele, um schema no caminho
-- de busca do chamador poderia decidir qual `config_global` a função lê).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.notify_whatsapp_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
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
