-- Fix: auto-confirma email de novos usuários ao inserir em auth.users
-- Necessário porque o catálogo (vendamais-catalogo.pages.dev) não tem SMTP configurado
-- e o Supabase bloqueia o login de usuários com email_confirmed_at = null.
CREATE OR REPLACE FUNCTION auth.auto_confirm_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public
AS $$
BEGIN
  IF NEW.email_confirmed_at IS NULL THEN
    NEW.email_confirmed_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_confirm_email ON auth.users;
CREATE TRIGGER trg_auto_confirm_email
  BEFORE INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION auth.auto_confirm_email();
