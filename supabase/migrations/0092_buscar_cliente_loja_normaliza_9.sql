-- Checkout da loja online: busca do cliente pelo telefone passa a casar COM ou SEM
-- o 9 migratório (e com/sem o 55). Antes fazia match exato, então um cliente salvo
-- como "8498180774" não era achado ao digitar "84998180774".

CREATE OR REPLACE FUNCTION public.normalizar_tel_br(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  WITH d AS (SELECT regexp_replace(coalesce(t, ''), '\D', '', 'g') AS v)
  SELECT CASE
    WHEN length(v) = 13 AND substring(v,1,2) = '55' AND substring(v,5,1) = '9'
      THEN substring(v,3,2) || substring(v,6)                 -- 55 + DDD + 9 + 8díg
    WHEN length(v) = 12 AND substring(v,1,2) = '55'
      THEN substring(v,3)                                     -- 55 + DDD + 8díg
    WHEN length(v) = 11 AND substring(v,3,1) = '9'
      THEN substring(v,1,2) || substring(v,4)                 -- DDD + 9 + 8díg
    ELSE v                                                    -- já canônico (10 díg)
  END
  FROM d;
$$;

CREATE OR REPLACE FUNCTION public.buscar_cliente_loja(p_empresa_id uuid, p_telefone text)
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT json_build_object(
    'nome', nome, 'telefone', telefone, 'email', email,
    'cep', cep, 'endereco', endereco, 'numero', numero,
    'complemento', complemento, 'bairro', bairro, 'cidade', cidade, 'estado', estado
  )
  FROM clientes
  WHERE empresa_id = p_empresa_id
    AND normalizar_tel_br(p_telefone) <> ''
    AND normalizar_tel_br(telefone) = normalizar_tel_br(p_telefone)
  ORDER BY created_at ASC
  LIMIT 1;
$function$;
