-- =========================================================
-- 0043: Salvar endereço do cliente do portal no lugar certo
-- =========================================================
-- O endereço era salvo só via update_perfil_cliente (tabela clientes).
-- Cliente do portal (sem empresa) NÃO tem linha em clientes, então o
-- endereço não era persistido — só ficava no localStorage e se perdia.
-- Esta RPC grava o endereço em profiles (sempre existe) e sincroniza
-- em clientes quando houver vínculo (user_id).
-- =========================================================
CREATE OR REPLACE FUNCTION salvar_endereco_portal(
  p_cep         text,
  p_endereco    text,
  p_numero      text,
  p_complemento text,
  p_bairro      text,
  p_cidade      text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  UPDATE profiles SET
    cep         = nullif(trim(p_cep), ''),
    endereco    = nullif(trim(p_endereco), ''),
    numero      = nullif(trim(p_numero), ''),
    complemento = nullif(trim(p_complemento), ''),
    bairro      = nullif(trim(p_bairro), ''),
    cidade      = nullif(trim(p_cidade), '')
  WHERE id = v_uid;

  UPDATE clientes SET
    cep         = nullif(trim(p_cep), ''),
    endereco    = nullif(trim(p_endereco), ''),
    numero      = nullif(trim(p_numero), ''),
    complemento = nullif(trim(p_complemento), ''),
    bairro      = nullif(trim(p_bairro), ''),
    cidade      = nullif(trim(p_cidade), '')
  WHERE user_id = v_uid;
END;
$$;

REVOKE EXECUTE ON FUNCTION salvar_endereco_portal(text,text,text,text,text,text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION salvar_endereco_portal(text,text,text,text,text,text) TO authenticated;
