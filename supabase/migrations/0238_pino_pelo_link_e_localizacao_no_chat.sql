-- 0238_pino_pelo_link_e_localizacao_no_chat.sql
-- O pedido montado pelo atendente também nasce com o ponto certo.
--
-- Quem compra na Loja Online já confere o pino: o mapa abre na cara dele, ele
-- arrasta, e o motoboy vai no ponto que o cliente apontou (migs 0160 e 0183).
-- Quem pede pelo WhatsApp, com o atendente digitando o endereço no gestor, não
-- tinha nada disso: a Nova venda grava só o texto do endereço, sem coordenada
-- nenhuma. O que o entregador abre é esse texto jogado no Google — que, sem
-- confiar no número, larga o pino no meio da rua. Rua certa, casa errada.
--
-- Duas portas pro mesmo ponto:
--
--   1. O LINK. O atendente digita o endereço, manda um link no chat, e o
--      cliente vê o mapa já centrado na casa dele — só ajusta e salva. Volta
--      pro cadastro (e pro pedido, quando já existe) na hora.
--
--   2. A LOCALIZAÇÃO DO WHATSAPP. Quando ele manda o pininho pelo próprio
--      WhatsApp, o lat/lng vem no webhook e a gente jogava fora: a mensagem
--      virava o texto "📍 Localização" e pronto. Agora fica guardada e o
--      atendente aproveita com um clique.
--
-- O que isto NÃO faz: mexer em taxa já combinada. Igual à 0183, o ponto novo só
-- é aceito dentro do raio que a loja entrega — senão o link viraria porta dos
-- fundos pra fechar perto e mudar de bairro depois.

-- ── 1. Localização que o cliente mandou pelo WhatsApp ────────────────────────
ALTER TABLE public.mensagens_chat
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision;

COMMENT ON COLUMN public.mensagens_chat.lat IS
  'Localização que veio na mensagem (WhatsApp manda lat/lng no pininho). '
  'Só preenchida em mensagem de localização — mig 0238.';

-- ── 2. O link que o cliente abre pra apontar a casa ──────────────────────────
CREATE TABLE IF NOT EXISTS public.pin_links (
  token         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id    uuid REFERENCES public.clientes(id) ON DELETE SET NULL,
  telefone      text,
  rua           text,
  numero        text,
  bairro        text,
  cidade        text,
  estado        text,
  cep           text,
  -- Onde o gestor acha que é (geocode do endereço digitado). O mapa do cliente
  -- abre aqui: ele ajusta metros, não procura a própria casa no Brasil inteiro.
  lat_sugerido  double precision,
  lng_sugerido  double precision,
  -- Pedido já fechado? O acerto vai direto nele também.
  pedido_id     uuid REFERENCES public.pedidos_delivery(id) ON DELETE SET NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  expira_em     timestamptz NOT NULL DEFAULT now() + interval '7 days',
  confirmado_em timestamptz,
  lat           double precision,
  lng           double precision
);

CREATE INDEX IF NOT EXISTS idx_pin_links_empresa
  ON public.pin_links (empresa_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pin_links_telefone
  ON public.pin_links (empresa_id, telefone);

ALTER TABLE public.pin_links ENABLE ROW LEVEL SECURITY;

-- A loja vê os links que ela mesma criou (pra saber quem já confirmou).
-- O cliente não entra por aqui: chega pelas funções abaixo, com o token.
DROP POLICY IF EXISTS "pin_links loja select" ON public.pin_links;
CREATE POLICY "pin_links loja select" ON public.pin_links
  FOR SELECT TO authenticated USING (empresa_id = current_empresa_id());

-- ── criar_pin_link ───────────────────────────────────────────────────────────
-- Chamada pela loja. Devolve o token que vira o link mandado no chat.
--
-- Reaproveita o link ainda aberto do mesmo telefone e mesmo endereço: o
-- atendente que manda de novo ("viu o link?") não pode invalidar o que o
-- cliente já tem na mão.
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
DECLARE
  v_emp    uuid := current_empresa_id();
  v_tel    text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_cli    uuid;
  v_token  uuid;
BEGIN
  IF v_emp IS NULL THEN
    RETURN json_build_object('ok', false, 'erro', 'Sem empresa.');
  END IF;
  IF coalesce(btrim(p_rua), '') = '' THEN
    RETURN json_build_object('ok', false, 'erro', 'Escreva a rua antes de pedir a confirmação.');
  END IF;

  IF v_tel <> '' THEN
    SELECT id INTO v_cli FROM clientes
     WHERE empresa_id = v_emp
       AND regexp_replace(coalesce(telefone, ''), '\D', '', 'g') = v_tel
     LIMIT 1;
  END IF;

  -- Link vivo pro mesmo endereço? Devolve ele, atualizando o ponto sugerido.
  SELECT token INTO v_token FROM pin_links
   WHERE empresa_id = v_emp
     AND coalesce(telefone, '') = v_tel
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
    v_emp, v_cli, nullif(v_tel, ''), btrim(p_rua), nullif(btrim(coalesce(p_numero, '')), ''),
    nullif(btrim(coalesce(p_bairro, '')), ''), nullif(btrim(coalesce(p_cidade, '')), ''),
    nullif(btrim(coalesce(p_estado, '')), ''), nullif(btrim(coalesce(p_cep, '')), ''),
    p_lat, p_lng, p_pedido_id
  ) RETURNING token INTO v_token;

  RETURN json_build_object('ok', true, 'token', v_token, 'reaproveitado', false);
END;
$$;

-- ── abrir_pin_link ───────────────────────────────────────────────────────────
-- Chamada pelo anônimo que tem o link. Devolve só o necessário pra desenhar o
-- mapa: o endereço, o ponto de partida e a loja (pro cliente se situar e pro
-- raio aparecer). Nada de telefone, nada de pedido, nada de cadastro.
CREATE OR REPLACE FUNCTION public.abrir_pin_link(p_token uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_l   record;
  v_e   record;
  v_lat double precision;
  v_lng double precision;
BEGIN
  SELECT * INTO v_l FROM pin_links WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'erro', 'Link não encontrado.');
  END IF;
  IF v_l.expira_em < now() THEN
    RETURN json_build_object('ok', false, 'erro', 'Este link expirou. Peça um novo à loja.');
  END IF;

  SELECT nome, latitude, longitude, raio_entrega_km INTO v_e
  FROM empresas WHERE id = v_l.empresa_id;

  -- Ponto de partida, na ordem do que é mais confiável:
  --   1. o que ele já confirmou neste link;
  --   2. o pino que ele mesmo apontou algum dia (cadastro), se for deste
  --      endereço — endereço diferente, pino diferente;
  --   3. o geocode que o gestor mandou junto.
  v_lat := v_l.lat; v_lng := v_l.lng;
  IF v_lat IS NULL AND v_l.cliente_id IS NOT NULL THEN
    SELECT c.endereco_lat, c.endereco_lng INTO v_lat, v_lng
    FROM clientes c
    WHERE c.id = v_l.cliente_id
      AND c.endereco_pin_manual = true
      AND c.endereco_pin_ref IS NOT DISTINCT FROM
          chave_endereco(v_l.rua, v_l.numero, v_l.bairro, v_l.cidade);
  END IF;
  IF v_lat IS NULL THEN v_lat := v_l.lat_sugerido; v_lng := v_l.lng_sugerido; END IF;

  RETURN json_build_object(
    'ok', true,
    'loja_nome',  v_e.nome,
    'loja_lat',   v_e.latitude,
    'loja_lng',   v_e.longitude,
    'raio_km',    v_e.raio_entrega_km,
    'rua',        v_l.rua,
    'numero',     v_l.numero,
    'bairro',     v_l.bairro,
    'cidade',     v_l.cidade,
    'estado',     v_l.estado,
    'cep',        v_l.cep,
    'lat',        v_lat,
    'lng',        v_lng,
    'confirmado', v_l.confirmado_em IS NOT NULL
  );
END;
$$;

-- ── confirmar_pin_link ───────────────────────────────────────────────────────
-- O cliente salvou o ponto. Vai pro cadastro dele (o próximo pedido já nasce
-- certo) e pro pedido, quando o link foi criado com um pedido junto.
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

  -- Mesma trava da 0183: fora da área de entrega não entra.
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

  -- Cadastro: pino de cliente é o único em que o cálculo de taxa confia
  -- (mig 0160), e a origem diz que quem apontou foi ele mesmo (mig 0164).
  IF v_l.cliente_id IS NOT NULL THEN
    UPDATE clientes SET
      endereco_lat        = p_lat,
      endereco_lng        = p_lng,
      endereco_pin_manual = true,
      endereco_pin_origem = 'cliente',
      endereco_pin_ref    = v_ref,
      endereco_pin_em     = now()
    WHERE id = v_l.cliente_id;
  ELSIF coalesce(v_l.telefone, '') <> '' THEN
    UPDATE clientes SET
      endereco_lat        = p_lat,
      endereco_lng        = p_lng,
      endereco_pin_manual = true,
      endereco_pin_origem = 'cliente',
      endereco_pin_ref    = v_ref,
      endereco_pin_em     = now()
    WHERE empresa_id = v_l.empresa_id
      AND regexp_replace(coalesce(telefone, ''), '\D', '', 'g') = v_l.telefone;
  END IF;

  -- Pedido junto: só mexe no que ainda vai rodar.
  IF v_l.pedido_id IS NOT NULL THEN
    UPDATE pedidos_delivery
       SET endereco_lat = p_lat,
           endereco_lng = p_lng,
           endereco_pin_corrigido_em = now()
     WHERE id = v_l.pedido_id
       AND status NOT IN ('entregue', 'cancelado');
  END IF;

  RETURN json_build_object('ok', true, 'lat', p_lat, 'lng', p_lng);
END;
$$;

REVOKE ALL ON FUNCTION public.criar_pin_link(text, text, text, text, text, text, text, double precision, double precision, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.criar_pin_link(text, text, text, text, text, text, text, double precision, double precision, uuid)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.abrir_pin_link(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.abrir_pin_link(uuid) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.confirmar_pin_link(uuid, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirmar_pin_link(uuid, double precision, double precision)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
