-- =========================================================
-- Migration 0265 - "Excluir empresa" do Super ADM passa a funcionar
-- =========================================================
-- O botão fazia DELETE direto em `empresas` e sempre falhava (13/09/2026, com o
-- Restaurante do Irmão): várias tabelas apontam pra empresa sem ON DELETE
-- CASCADE (profiles, produtos, vendas, clientes...), e a proteção da mesa
-- Balcão (mig 0113) barrava até a exclusão da loja inteira.
--
-- 1. A proteção do Balcão continua valendo pra quem apaga a mesa, mas deixa
--    passar quando a própria empresa já saiu (exclusão da loja em cascata).
-- 2. excluir_empresa_completa(): só o Super ADM; apaga, numa transação, o que
--    depende da loja e os logins que eram SÓ dela.
-- =========================================================

CREATE OR REPLACE FUNCTION public.impedir_excluir_balcao()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Loja sendo apagada inteira: a linha da empresa já não existe nesta hora.
  IF OLD.is_balcao AND EXISTS (SELECT 1 FROM empresas WHERE id = OLD.empresa_id) THEN
    RAISE EXCEPTION 'A mesa Balcão não pode ser excluída.';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.excluir_empresa_completa(p_empresa uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_nome  text;
  v_users uuid[];
BEGIN
  IF current_perfil() IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Só o Super ADM pode excluir uma empresa.';
  END IF;
  SELECT nome INTO v_nome FROM empresas WHERE id = p_empresa;
  IF v_nome IS NULL THEN
    RETURN json_build_object('ok', false, 'erro', 'Empresa não encontrada.');
  END IF;

  -- Logins que eram só desta loja (nunca o do próprio Super ADM).
  SELECT array_agg(id) INTO v_users FROM profiles
   WHERE empresa_id = p_empresa AND perfil <> 'super_admin';

  -- O que aponta pra empresa sem cascata. O resto (mesas, comandas,
  -- categorias, mensalidade...) sai junto com a empresa.
  DELETE FROM comandas            WHERE empresa_id = p_empresa;
  DELETE FROM venda_itens         WHERE empresa_id = p_empresa;
  DELETE FROM pagamentos          WHERE empresa_id = p_empresa;
  DELETE FROM comissoes           WHERE empresa_id = p_empresa;
  DELETE FROM comissoes_indicacao WHERE empresa_id = p_empresa;
  DELETE FROM cashback_transacoes WHERE empresa_id = p_empresa;
  DELETE FROM vendas              WHERE empresa_id = p_empresa;
  DELETE FROM caixa_movimentos    WHERE empresa_id = p_empresa;
  DELETE FROM caixas              WHERE empresa_id = p_empresa;
  DELETE FROM estoque_movimentos  WHERE empresa_id = p_empresa;
  DELETE FROM casco_movimentos    WHERE empresa_id = p_empresa;
  DELETE FROM pedidos_delivery    WHERE empresa_id = p_empresa;
  DELETE FROM clientes            WHERE empresa_id = p_empresa;
  DELETE FROM produtos            WHERE empresa_id = p_empresa;
  DELETE FROM profiles            WHERE empresa_id = p_empresa;
  DELETE FROM empresas            WHERE id = p_empresa;

  IF v_users IS NOT NULL THEN
    DELETE FROM auth.identities WHERE user_id = ANY (v_users);
    DELETE FROM auth.users      WHERE id = ANY (v_users);
  END IF;

  RETURN json_build_object('ok', true, 'empresa', v_nome, 'logins_apagados', coalesce(array_length(v_users, 1), 0));
END;
$$;
REVOKE ALL ON FUNCTION public.excluir_empresa_completa(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.excluir_empresa_completa(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
