-- Pontos/cashback da plataforma valem SÓ como desconto em compra dentro do app.
-- O app já não tem botão de saque, mas o RPC seguia aberto pra qualquer usuário logado.
-- Fecha no servidor: ninguém consegue gerar pedido de saque em dinheiro.
-- (Política da Play Store: sem recurso financeiro — ver memória project-playstore-fwc.)

CREATE OR REPLACE FUNCTION public.solicitar_resgate(p_pontos integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Os pontos valem apenas como desconto em compras dentro do app. Saque em dinheiro não está disponível.';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.solicitar_resgate(integer) FROM PUBLIC, anon, authenticated;
