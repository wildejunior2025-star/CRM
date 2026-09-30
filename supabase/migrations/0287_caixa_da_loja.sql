-- 0287_caixa_da_loja.sql
-- O caixa passa a ser DA LOJA, não de cada login.
--
-- Era um caixa por usuário: `current_caixa_id()` pegava o caixa aberto por
-- auth.uid(). Na Branka a mesma pessoa tem dois logins ("Branca" e "Branca
-- (2º acesso)") e a conta caía num caixa ou no outro conforme o aparelho que
-- fechou. Resultado em 30/09: o caixa da tela mostrava R$ 331 de fiado e a tela
-- do Fiado mostrava R$ 411 — os R$ 80 do Jp cabeleireiro tinham caído no caixa
-- do outro login. E, pior, o caixa daquele login estava aberto desde 24/09, com
-- venda daquele dia misturada no meio.
--
-- Agora a venda entra no caixa ABERTO DA LOJA, qualquer que seja o login que
-- fechou a conta. Se houver mais de um aberto (herança do modelo antigo), vale
-- o mais recente — e a tela do Caixa avisa pra fechar o atrasado.
CREATE OR REPLACE FUNCTION public.current_caixa_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from caixas
   where empresa_id = current_empresa_id()
     and status = 'aberto'
   order by aberto_em desc
   limit 1;
$function$;

COMMENT ON FUNCTION public.current_caixa_id() IS
  'Caixa aberto DA LOJA (o mais recente), não o do usuário logado (mig 0287).';

-- Quem vende precisa saber se a loja está com caixa aberto, mesmo que quem
-- tenha aberto seja outra pessoa. A RLS de `caixas` só deixa o não-admin ver os
-- caixas dele, então a resposta vem por função — que devolve só o id, sem
-- expor valores de gaveta pra quem não é dono.
CREATE OR REPLACE FUNCTION public.caixa_aberto_da_loja()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select current_caixa_id();
$function$;

REVOKE ALL ON FUNCTION public.caixa_aberto_da_loja() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.caixa_aberto_da_loja() TO authenticated;

NOTIFY pgrst, 'reload schema';
