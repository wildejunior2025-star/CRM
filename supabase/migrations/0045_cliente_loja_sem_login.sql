-- =========================================================
-- 0045: Cliente da loja (lojaonline/WhatsApp) sem login
-- =========================================================
-- A vitrine pública (lojaonline) e o bot criam CLIENTE SÓ DA LOJA,
-- sem conta no app e sem senha, identificado pelo TELEFONE.
--   upsert_cliente_loja  → cria/atualiza o cliente da loja (anon)
--   buscar_cliente_loja  → busca os dados pelo telefone p/ pré-preencher
-- Ambas SECURITY DEFINER (a tabela clientes tem RLS por empresa).
-- =========================================================

CREATE OR REPLACE FUNCTION upsert_cliente_loja(
  p_empresa_id  uuid,
  p_nome        text,
  p_telefone    text,
  p_email       text,
  p_cep         text,
  p_endereco    text,
  p_numero      text,
  p_complemento text,
  p_bairro      text,
  p_cidade      text,
  p_estado      text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id  uuid;
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
BEGIN
  IF p_empresa_id IS NULL THEN RAISE EXCEPTION 'Empresa obrigatória'; END IF;
  IF nullif(trim(coalesce(p_nome, '')), '') IS NULL THEN RAISE EXCEPTION 'Nome obrigatório'; END IF;
  IF v_tel = '' THEN RAISE EXCEPTION 'Telefone obrigatório'; END IF;

  -- procura cliente já existente nessa loja pelo telefone (só dígitos)
  SELECT id INTO v_id
  FROM clientes
  WHERE empresa_id = p_empresa_id
    AND regexp_replace(coalesce(telefone, ''), '\D', '', 'g') = v_tel
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO clientes (
      empresa_id, nome, telefone, email, cep, endereco, numero, complemento,
      bairro, cidade, estado, tipo, origem
    ) VALUES (
      p_empresa_id, trim(p_nome), p_telefone, nullif(trim(coalesce(p_email,'')),''),
      nullif(trim(coalesce(p_cep,'')),''), nullif(trim(coalesce(p_endereco,'')),''),
      nullif(trim(coalesce(p_numero,'')),''), nullif(trim(coalesce(p_complemento,'')),''),
      nullif(trim(coalesce(p_bairro,'')),''), nullif(trim(coalesce(p_cidade,'')),''),
      nullif(trim(coalesce(p_estado,'')),''), 'pf', 'cardapio'
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE clientes SET
      nome        = coalesce(nullif(trim(p_nome), ''), nome),
      email       = coalesce(nullif(trim(coalesce(p_email,'')),''), email),
      cep         = coalesce(nullif(trim(coalesce(p_cep,'')),''), cep),
      endereco    = coalesce(nullif(trim(coalesce(p_endereco,'')),''), endereco),
      numero      = coalesce(nullif(trim(coalesce(p_numero,'')),''), numero),
      complemento = coalesce(nullif(trim(coalesce(p_complemento,'')),''), complemento),
      bairro      = coalesce(nullif(trim(coalesce(p_bairro,'')),''), bairro),
      cidade      = coalesce(nullif(trim(coalesce(p_cidade,'')),''), cidade),
      estado      = coalesce(nullif(trim(coalesce(p_estado,'')),''), estado)
    WHERE id = v_id;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION buscar_cliente_loja(
  p_empresa_id uuid,
  p_telefone   text
) RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT json_build_object(
    'nome', nome, 'telefone', telefone, 'email', email,
    'cep', cep, 'endereco', endereco, 'numero', numero,
    'complemento', complemento, 'bairro', bairro, 'cidade', cidade, 'estado', estado
  )
  FROM clientes
  WHERE empresa_id = p_empresa_id
    AND regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g') <> ''
    AND regexp_replace(coalesce(telefone, ''), '\D', '', 'g')
        = regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g')
  ORDER BY created_at ASC
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION upsert_cliente_loja(uuid,text,text,text,text,text,text,text,text,text,text) FROM public;
GRANT  EXECUTE ON FUNCTION upsert_cliente_loja(uuid,text,text,text,text,text,text,text,text,text,text) TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION buscar_cliente_loja(uuid,text) FROM public;
GRANT  EXECUTE ON FUNCTION buscar_cliente_loja(uuid,text) TO anon, authenticated;
