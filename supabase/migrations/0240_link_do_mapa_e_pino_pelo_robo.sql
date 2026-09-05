-- 0240_link_do_mapa_e_pino_pelo_robo.sql
-- O robô também manda o link do mapa pro cliente conferir o ponto.
--
-- Quem pede PRA OUTRA PESSOA não pode mandar a própria localização: o GPS dele
-- é o lugar errado. O que essa pessoa faz é colar um link do Google Maps. Aí o
-- robô lê o endereço escrito dentro do link, e devolve o link do mapa NOSSO
-- (mig 0238) pra alguém arrastar o pino até a porta certa.
--
-- Duas coisas faltavam pra isso funcionar:
--
--   1. `criar_pin_link` só servia pra loja logada — ela descobre a empresa pelo
--      `current_empresa_id()`, que é nulo pro robô (service_role). Agora existe
--      uma irmã que recebe a empresa por parâmetro, e a da loja passa a chamar
--      essa, pra não haver duas versões da mesma regra.
--
--   2. Quando o cliente confirmava o ponto, ele ia pro cadastro e pro pedido —
--      mas não pro CARRINHO do robô, que é onde a conversa em andamento guarda
--      o endereço. O cliente arrastava o pino, o robô fechava o pedido logo
--      depois e mandava o ponto velho. Agora o acerto entra na conversa também.

-- ── criar_pin_link_para ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.criar_pin_link_para(
  p_empresa_id uuid,
  p_telefone   text,
  p_rua        text,
  p_numero     text DEFAULT NULL,
  p_bairro     text DEFAULT NULL,
  p_cidade     text DEFAULT NULL,
  p_estado     text DEFAULT NULL,
  p_cep        text DEFAULT NULL,
  p_lat        double precision DEFAULT NULL,
  p_lng        double precision DEFAULT NULL,
  p_pedido_id  uuid DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tel   text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_cli   uuid;
  v_token uuid;
BEGIN
  IF p_empresa_id IS NULL THEN
    RETURN json_build_object('ok', false, 'erro', 'Sem empresa.');
  END IF;
  IF coalesce(btrim(p_rua), '') = '' THEN
    RETURN json_build_object('ok', false, 'erro', 'Escreva a rua antes de pedir a confirmação.');
  END IF;

  -- Casa pelos 8 últimos dígitos: o mesmo número chega com e sem o 9 do celular.
  IF v_tel <> '' THEN
    SELECT id INTO v_cli FROM clientes
     WHERE empresa_id = p_empresa_id
       AND regexp_replace(coalesce(telefone, ''), '\D', '', 'g') LIKE '%' || right(v_tel, 8)
     LIMIT 1;
  END IF;

  -- Link ainda aberto pro mesmo endereço? Devolve ele: o atendente (ou o robô)
  -- que manda de novo não pode invalidar o link que o cliente já tem na mão.
  SELECT token INTO v_token FROM pin_links
   WHERE empresa_id = p_empresa_id
     AND right(coalesce(telefone, ''), 8) = right(v_tel, 8)
     AND confirmado_em IS NULL
     AND expira_em > now()
     AND chave_endereco(rua, numero, bairro, cidade)
         IS NOT DISTINCT FROM chave_endereco(p_rua, p_numero, p_bairro, p_cidade)
   ORDER BY criado_em DESC LIMIT 1;

  IF v_token IS NOT NULL THEN
    UPDATE pin_links SET
      lat_sugerido = coalesce(p_lat, lat_sugerido),
      lng_sugerido = coalesce(p_lng, lng_sugerido),
      pedido_id    = coalesce(p_pedido_id, pedido_id),
      expira_em    = now() + interval '7 days'
    WHERE token = v_token;
    RETURN json_build_object('ok', true, 'token', v_token, 'reaproveitado', true);
  END IF;

  INSERT INTO pin_links (
    empresa_id, cliente_id, telefone, rua, numero, bairro, cidade, estado, cep,
    lat_sugerido, lng_sugerido, pedido_id
  ) VALUES (
    p_empresa_id, v_cli, nullif(v_tel, ''), btrim(p_rua),
    nullif(btrim(coalesce(p_numero, '')), ''), nullif(btrim(coalesce(p_bairro, '')), ''),
    nullif(btrim(coalesce(p_cidade, '')), ''), nullif(btrim(coalesce(p_estado, '')), ''),
    nullif(btrim(coalesce(p_cep, '')), ''), p_lat, p_lng, p_pedido_id
  ) RETURNING token INTO v_token;

  RETURN json_build_object('ok', true, 'token', v_token, 'reaproveitado', false);
END;
$$;

-- A da loja vira uma casca: mesma regra, empresa vinda da sessão.
CREATE OR REPLACE FUNCTION public.criar_pin_link(
  p_telefone  text,
  p_rua       text,
  p_numero    text DEFAULT NULL,
  p_bairro    text DEFAULT NULL,
  p_cidade    text DEFAULT NULL,
  p_estado    text DEFAULT NULL,
  p_cep       text DEFAULT NULL,
  p_lat       double precision DEFAULT NULL,
  p_lng       double precision DEFAULT NULL,
  p_pedido_id uuid DEFAULT NULL
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN criar_pin_link_para(
    current_empresa_id(), p_telefone, p_rua, p_numero, p_bairro,
    p_cidade, p_estado, p_cep, p_lat, p_lng, p_pedido_id);
END;
$$;

-- ── confirmar_pin_link: o acerto entra também na conversa em andamento ───────
CREATE OR REPLACE FUNCTION public.confirmar_pin_link(
  p_token uuid,
  p_lat   double precision,
  p_lng   double precision
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_l    record;
  v_e    record;
  v_raio double precision;
  v_dist double precision;
  v_ref  text;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL
     OR p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN
    RETURN json_build_object('ok', false, 'erro', 'Ponto inválido.');
  END IF;

  SELECT * INTO v_l FROM pin_links WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'erro', 'Link não encontrado.');
  END IF;
  IF v_l.expira_em < now() THEN
    RETURN json_build_object('ok', false, 'erro', 'Este link expirou. Peça um novo à loja.');
  END IF;

  SELECT latitude, longitude, raio_entrega_km INTO v_e
  FROM empresas WHERE id = v_l.empresa_id;

  IF v_e.latitude IS NOT NULL AND v_e.longitude IS NOT NULL THEN
    v_raio := coalesce(nullif(v_e.raio_entrega_km, 0), 15);
    v_dist := 6371 * acos(least(1, greatest(-1,
        cos(radians(v_e.latitude)) * cos(radians(p_lat))
      * cos(radians(p_lng) - radians(v_e.longitude))
      + sin(radians(v_e.latitude)) * sin(radians(p_lat)))));
    IF v_dist > v_raio THEN
      RETURN json_build_object(
        'ok', false,
        'erro', 'Esse ponto fica fora da área de entrega da loja. Fale com a loja pelo WhatsApp.');
    END IF;
  END IF;

  UPDATE pin_links
     SET lat = p_lat, lng = p_lng, confirmado_em = now()
   WHERE token = p_token;

  v_ref := chave_endereco(v_l.rua, v_l.numero, v_l.bairro, v_l.cidade);

  IF v_l.cliente_id IS NOT NULL THEN
    UPDATE clientes SET
      endereco_lat = p_lat, endereco_lng = p_lng,
      endereco_pin_manual = true, endereco_pin_origem = 'cliente',
      endereco_pin_ref = v_ref, endereco_pin_em = now()
    WHERE id = v_l.cliente_id;
  ELSIF coalesce(v_l.telefone, '') <> '' THEN
    UPDATE clientes SET
      endereco_lat = p_lat, endereco_lng = p_lng,
      endereco_pin_manual = true, endereco_pin_origem = 'cliente',
      endereco_pin_ref = v_ref, endereco_pin_em = now()
    WHERE empresa_id = v_l.empresa_id
      AND regexp_replace(coalesce(telefone, ''), '\D', '', 'g') LIKE '%' || right(v_l.telefone, 8);
  END IF;

  -- A CONVERSA EM ANDAMENTO. Sem isto o cliente arrastava o pino, o robô
  -- fechava o pedido em seguida e mandava o ponto velho — o acerto chegava
  -- tarde demais, justamente no pedido que ele estava fazendo.
  IF coalesce(v_l.telefone, '') <> '' THEN
    UPDATE whatsapp_carrinho
       SET endereco_lat = p_lat, endereco_lng = p_lng, updated_at = now()
     WHERE empresa_id = v_l.empresa_id
       AND right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 8) = right(v_l.telefone, 8);
  END IF;

  IF v_l.pedido_id IS NOT NULL THEN
    UPDATE pedidos_delivery
       SET endereco_lat = p_lat, endereco_lng = p_lng, endereco_pin_corrigido_em = now()
     WHERE id = v_l.pedido_id
       AND status NOT IN ('entregue', 'cancelado');
  END IF;

  RETURN json_build_object('ok', true, 'lat', p_lat, 'lng', p_lng);
END;
$$;

REVOKE ALL ON FUNCTION public.criar_pin_link_para(uuid, text, text, text, text, text, text, text, double precision, double precision, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.criar_pin_link_para(uuid, text, text, text, text, text, text, text, double precision, double precision, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
