-- O CHECKOUT PRECISA SABER O MOTIVO, NAO SO QUE PRECISA (25/10/2026)
--
-- `buscar_cliente_loja` devolvia `reconfirmar_endereco` (sim/nao), entao a tela
-- so conseguia dar um recado generico. Com o motivo (mig 0394) ela fala do
-- problema real: "nao conseguimos confirmar o bairro".
CREATE OR REPLACE FUNCTION public.buscar_cliente_loja(p_empresa_id uuid, p_telefone text)
 RETURNS json
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT json_build_object(
    'nome', nome, 'telefone', telefone, 'email', email,
    'cep', cep, 'endereco', endereco, 'numero', numero,
    'complemento', complemento, 'bairro', bairro, 'cidade', cidade, 'estado', estado,
    'reconfirmar_endereco', reconfirmar_endereco,
    'reconfirmar_motivo', reconfirmar_motivo,
    'endereco_lat', endereco_lat,
    'endereco_lng', endereco_lng,
    'endereco_pin_manual', endereco_pin_manual,
    'endereco_pin_ref', endereco_pin_ref
  )
  FROM clientes
  WHERE empresa_id = p_empresa_id
    AND normalizar_tel_br(p_telefone) <> ''
    AND normalizar_tel_br(telefone) = normalizar_tel_br(p_telefone)
  ORDER BY created_at ASC
  LIMIT 1;
$function$;
