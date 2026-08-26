-- 0194_mp_conectado_loja.sql
-- "Esta loja tem Mercado Pago ligado?" sem entregar o token pro navegador.
--
-- O botao de PIX na mesa (mig 0193) perguntava isso lendo mercadopago_contas
-- direto do front, e a resposta vinha sempre NAO: a tabela tem RLS sem policy
-- nenhuma -- de proposito, porque e la que ficam access_token e refresh_token da
-- loja. Dar SELECT ali pro navegador seria entregar a chave da conta do MP.
--
-- Entao a pergunta vira uma funcao que responde so sim/nao.
--
-- Nao usa `empresas.mp_conectado` de proposito: esse campo esta dessincronizado
-- (loja com token valido e a flag em false, resto do bloqueio do MP em agosto).
-- Quem manda e ter token: e ele que cobra.

CREATE OR REPLACE FUNCTION public.mp_conectado_loja()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM mercadopago_contas
    WHERE empresa_id = current_empresa_id()
      AND access_token IS NOT NULL
  );
$fn$;

REVOKE EXECUTE ON FUNCTION public.mp_conectado_loja() FROM public;
GRANT  EXECUTE ON FUNCTION public.mp_conectado_loja() TO authenticated;

NOTIFY pgrst, 'reload schema';
