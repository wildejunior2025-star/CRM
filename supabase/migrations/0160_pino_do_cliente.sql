-- 0160_pino_do_cliente.sql
-- O ponto que o cliente marca no mapa passa a MORAR no cadastro dele.
--
-- O buraco (Zebu, 15/08/2026): a coordenada era calculada no checkout, gravada
-- no pedido e jogada fora. No pedido seguinte o sistema geocodificava o texto do
-- endereço DE NOVO — e quando o buscador de mapa erra a rua, erra sempre igual.
--
-- Caso real: FLAVIO PACHECO, Av. das Fronteiras 400. Ele arrastou o pino certo
-- uma vez (0,49 km → taxa R$ 4). Nos 4 pedidos seguintes o buscador devolveu
-- sempre -5.7377259/-35.2504049 (3,08 km → taxa R$ 8). Mesmo endereço, R$ 4 a
-- mais por pedido, e o acerto que ele fez à mão nunca foi aproveitado.
--
-- Agora:
--   * o pino fica no cliente (endereco_lat/lng)
--   * `endereco_pin_manual` separa o que o cliente APONTOU do que o buscador
--     chutou — só o apontado é reaproveitado pra calcular taxa
--   * `endereco_pin_ref` guarda a que endereço aquele pino pertence; mudou de
--     casa, o pino velho não vale mais
--
-- Sem risco pro que já existe: as colunas nascem nulas, e quem nunca marcou o
-- pino continua caindo no geocode como hoje.

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS endereco_lat        double precision,
  ADD COLUMN IF NOT EXISTS endereco_lng        double precision,
  ADD COLUMN IF NOT EXISTS endereco_pin_manual boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS endereco_pin_ref    text,
  ADD COLUMN IF NOT EXISTS endereco_pin_em     timestamptz;

COMMENT ON COLUMN public.clientes.endereco_lat IS
  'Ponto de entrega do cliente. Reaproveitado no checkout só quando endereco_pin_manual = true (mig 0160).';
COMMENT ON COLUMN public.clientes.endereco_pin_manual IS
  'true = o cliente arrastou/clicou/usou GPS. false = veio do buscador de mapa, não confiável pra taxa.';
COMMENT ON COLUMN public.clientes.endereco_pin_ref IS
  'Endereço normalizado a que o pino pertence. Mudou o endereço, o pino é descartado.';

-- Chave do endereço: normaliza pra comparar "Av. das Fronteiras 400" com
-- "avenida das fronteiras  400" sem falso negativo por acento/caixa/espaço.
CREATE OR REPLACE FUNCTION public.chave_endereco(
  p_rua text, p_numero text, p_bairro text, p_cidade text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT nullif(
    regexp_replace(
      lower(unaccent(btrim(concat_ws(' ',
        nullif(btrim(coalesce(p_rua, '')), ''),
        nullif(btrim(coalesce(p_numero, '')), ''),
        nullif(btrim(coalesce(p_bairro, '')), ''),
        nullif(btrim(coalesce(p_cidade, '')), '')
      )))),
      '\s+', ' ', 'g'),
    '');
$function$;

-- ── buscar_cliente_loja: devolve o pino junto ────────────────────────────────
-- Mesma assinatura de antes; só o JSON cresceu. Frontend velho ignora os campos
-- novos e continua funcionando igual.
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

-- ── upsert_cliente_loja: grava o pino ────────────────────────────────────────
-- Os 3 parâmetros novos têm DEFAULT NULL, então a chamada antiga (11 args) do
-- frontend que ainda estiver aberto no navegador continua resolvendo pra cá.
-- Precisa de DROP porque criar com mais parâmetros geraria uma SOBRECARGA e a
-- chamada por nome do PostgREST ficaria ambígua entre as duas versões.
DROP FUNCTION IF EXISTS public.upsert_cliente_loja(
  uuid, text, text, text, text, text, text, text, text, text, text);

CREATE FUNCTION public.upsert_cliente_loja(
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
  p_estado      text,
  p_lat         double precision DEFAULT NULL,
  p_lng         double precision DEFAULT NULL,
  p_pin_manual  boolean          DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id   uuid;
  v_tel  text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_ref  text := chave_endereco(p_endereco, p_numero, p_bairro, p_cidade);
  v_grava boolean;
BEGIN
  IF p_empresa_id IS NULL THEN RAISE EXCEPTION 'Empresa obrigatória'; END IF;
  IF nullif(trim(coalesce(p_nome, '')), '') IS NULL THEN RAISE EXCEPTION 'Nome obrigatório'; END IF;
  IF v_tel = '' THEN RAISE EXCEPTION 'Telefone obrigatório'; END IF;

  SELECT id INTO v_id
  FROM clientes
  WHERE empresa_id = p_empresa_id
    AND regexp_replace(coalesce(telefone, ''), '\D', '', 'g') = v_tel
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_id IS NULL THEN
    INSERT INTO clientes (
      empresa_id, nome, telefone, email, cep, endereco, numero, complemento,
      bairro, cidade, estado, tipo, origem,
      endereco_lat, endereco_lng, endereco_pin_manual, endereco_pin_ref, endereco_pin_em
    ) VALUES (
      p_empresa_id, trim(p_nome), p_telefone, nullif(trim(coalesce(p_email,'')),''),
      nullif(trim(coalesce(p_cep,'')),''), nullif(trim(coalesce(p_endereco,'')),''),
      nullif(trim(coalesce(p_numero,'')),''), nullif(trim(coalesce(p_complemento,'')),''),
      nullif(trim(coalesce(p_bairro,'')),''), nullif(trim(coalesce(p_cidade,'')),''),
      nullif(trim(coalesce(p_estado,'')),''), 'pf', 'cardapio',
      p_lat, p_lng, coalesce(p_pin_manual, false) AND p_lat IS NOT NULL,
      CASE WHEN p_lat IS NOT NULL THEN v_ref END,
      CASE WHEN p_lat IS NOT NULL THEN now() END
    )
    RETURNING id INTO v_id;
  ELSE
    -- Pino do buscador NÃO derruba pino que o cliente apontou pro mesmo
    -- endereço — foi exatamente esse atropelo que inflou a taxa do Flávio.
    -- Mudou de endereço, o pino velho perde a validade e o novo entra.
    SELECT p_lat IS NOT NULL
       AND (coalesce(p_pin_manual, false)
            OR c.endereco_pin_manual IS NOT TRUE
            OR c.endereco_pin_ref IS DISTINCT FROM v_ref)
      INTO v_grava
    FROM clientes c WHERE c.id = v_id;

    UPDATE clientes SET
      nome        = coalesce(nullif(trim(p_nome), ''), nome),
      email       = coalesce(nullif(trim(coalesce(p_email,'')),''), email),
      cep         = coalesce(nullif(trim(coalesce(p_cep,'')),''), cep),
      endereco    = coalesce(nullif(trim(coalesce(p_endereco,'')),''), endereco),
      numero      = coalesce(nullif(trim(coalesce(p_numero,'')),''), numero),
      complemento = coalesce(nullif(trim(coalesce(p_complemento,'')),''), complemento),
      bairro      = coalesce(nullif(trim(coalesce(p_bairro,'')),''), bairro),
      cidade      = coalesce(nullif(trim(coalesce(p_cidade,'')),''), cidade),
      estado      = coalesce(nullif(trim(coalesce(p_estado,'')),''), estado),
      reconfirmar_endereco = false,
      endereco_lat        = CASE WHEN v_grava THEN p_lat  ELSE endereco_lat END,
      endereco_lng        = CASE WHEN v_grava THEN p_lng  ELSE endereco_lng END,
      endereco_pin_manual = CASE WHEN v_grava THEN coalesce(p_pin_manual, false) ELSE endereco_pin_manual END,
      endereco_pin_ref    = CASE WHEN v_grava THEN v_ref  ELSE endereco_pin_ref END,
      endereco_pin_em     = CASE WHEN v_grava THEN now()  ELSE endereco_pin_em END
    WHERE id = v_id;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_cliente_loja(
  uuid, text, text, text, text, text, text, text, text, text, text,
  double precision, double precision, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_cliente_loja(
  uuid, text, text, text, text, text, text, text, text, text, text,
  double precision, double precision, boolean) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
