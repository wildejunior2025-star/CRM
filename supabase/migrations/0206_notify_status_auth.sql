-- Aviso de status voltando a sair nos pedidos aceitos automaticamente.
--
-- O gatilho montava o header como 'Bearer ' || service_key, e a chave
-- (config_global.supabase_service_key) nunca existiu — ia um "Bearer " vazio.
-- Passou meses despercebido porque a Edge Function aceitava chamada sem token;
-- quando ela foi redeployada com verify_jwt ligado, o portao passou a devolver
-- 401 (UNAUTHORIZED_INVALID_JWT_FORMAT) e o cliente parou de receber.
--
-- Ninguem viu na hora porque mexer no status PELO PAINEL nao usa este caminho:
-- ali quem chama a funcao e o navegador, com o token do lojista. So morria o
-- caminho automatico — pedido que entra pelo site e e aceito sozinho, que e
-- justamente o que ninguem fica olhando.
--
-- Agora a chave fica em config_global.edge_auth_key (a anon, que e publica de
-- proposito: serve so pra passar no portao; quem manda mensagem e a funcao, com
-- a service role do ambiente dela). E quando a chave faltar, o gatilho grita no
-- log em vez de sumir calado.

insert into config_global (chave, valor)
values (
  'edge_auth_key',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljeXRyc3FkdnJ2aWloa3Fmdm5vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMjc1NDcsImV4cCI6MjA5NjcwMzU0N30.zAq-8gaw2U9wvwBJCX_rK2jP-tnjOL5VPS23fFxf2Zc'
)
on conflict (chave) do update set valor = excluded.valor;

create or replace function notify_whatsapp_status_change()
returns trigger
language plpgsql
-- security definer é o que faz a chave ser LIDA: config_global tem RLS de
-- super_admin, e o gatilho roda no papel de quem gravou o pedido (o cliente do
-- site, anon). Sem isso o SELECT volta vazio e nenhum aviso sai.
security definer
set search_path = public
as $$
DECLARE
  notify_statuses TEXT[] := ARRAY['confirmado','em_preparo','saiu_entrega','entregue','cancelado'];
  supabase_url TEXT;
  auth_key     TEXT;
BEGIN
  -- Só dispara quando status realmente muda para um dos listados
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = ANY(notify_statuses) THEN
    SELECT valor INTO supabase_url FROM config_global WHERE chave = 'supabase_url'   LIMIT 1;
    SELECT valor INTO auth_key     FROM config_global WHERE chave = 'edge_auth_key'  LIMIT 1;

    -- Fallback: usa URL padrão do projeto se não estiver na config_global
    supabase_url := COALESCE(supabase_url, 'https://ycytrsqdvrviihkqfvno.supabase.co');

    -- Sem chave o portão recusa e o aviso morre em silêncio: melhor deixar
    -- registrado no log do banco pra dar pra achar.
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
$$;
