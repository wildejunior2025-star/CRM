-- 0183_cliente_confere_o_ponto.sql
-- O cliente vê o ponto da entrega no mapa e pode arrastar pro lugar certo.
--
-- Hoje quem descobre que o pino está errado é o motoboy, na rua, rodando atrás
-- de uma casa que não é a do pedido. O cliente é o único que sabe onde mora —
-- e é o único que nunca via o ponto: a tela de acompanhamento mostrava só o
-- texto do endereço, e texto certo com pino errado é o caso mais comum (é o
-- buscador de mapa que erra, não o cliente).
--
-- Agora ele confere na hora que faz o pedido, arrasta se estiver fora do lugar,
-- e o acerto vai direto pro pedido — o link de navegação do motoboy passa a
-- apontar pro ponto novo — e pro cadastro dele, pra não errar no próximo.
--
-- O que a correção NÃO faz: mexer na taxa. O preço foi combinado no fechamento
-- do pedido e não muda por ajuste de pino. Pra não virar porta dos fundos
-- ("fecho perto, arrasto pra longe"), o ponto novo só é aceito dentro do raio
-- que a loja entrega.

ALTER TABLE public.pedidos_delivery
  ADD COLUMN IF NOT EXISTS endereco_pin_corrigido_em timestamptz;

COMMENT ON COLUMN public.pedidos_delivery.endereco_pin_corrigido_em IS
  'Quando o CLIENTE arrastou o ponto no mapa, já com o pedido feito (mig 0183). '
  'Serve pra avisar o motoboy que pode já ter saído com o ponto velho.';

-- ── corrigir_pin_pedido ──────────────────────────────────────────────────────
-- Chamada pelo anônimo: quem tem o link do pedido (uuid) mexe no pedido dele,
-- mesma confiança de `avaliar_pedido`.
CREATE OR REPLACE FUNCTION public.corrigir_pin_pedido(
  p_pedido_id uuid,
  p_lat       double precision,
  p_lng       double precision
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ped   record;
  v_emp   record;
  v_raio  double precision;
  v_dist  double precision;
  v_ref   text;
  v_tel   text;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL
     OR p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN
    RETURN json_build_object('ok', false, 'erro', 'Ponto inválido.');
  END IF;

  SELECT * INTO v_ped FROM pedidos_delivery WHERE id = p_pedido_id;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'erro', 'Pedido não encontrado.');
  END IF;

  IF coalesce(v_ped.tipo_entrega, 'entrega') <> 'entrega' THEN
    RETURN json_build_object('ok', false, 'erro', 'Esse pedido é para retirada.');
  END IF;

  -- Pedido encerrado não muda mais: entregue já foi, cancelado não vai.
  IF v_ped.status IN ('entregue', 'cancelado') THEN
    RETURN json_build_object('ok', false, 'erro', 'Esse pedido já foi encerrado.');
  END IF;

  SELECT latitude, longitude, raio_entrega_km INTO v_emp
  FROM empresas WHERE id = v_ped.empresa_id;

  -- Só aceita dentro da área que a loja entrega. Sem raio configurado, 15 km —
  -- folgado o bastante pra qualquer correção de verdade e apertado o bastante
  -- pra barrar quem quisesse mudar de cidade depois de fechar a conta.
  IF v_emp.latitude IS NOT NULL AND v_emp.longitude IS NOT NULL THEN
    v_raio := coalesce(nullif(v_emp.raio_entrega_km, 0), 15);
    v_dist := 6371 * acos(least(1, greatest(-1,
        cos(radians(v_emp.latitude)) * cos(radians(p_lat))
      * cos(radians(p_lng) - radians(v_emp.longitude))
      + sin(radians(v_emp.latitude)) * sin(radians(p_lat)))));
    IF v_dist > v_raio THEN
      RETURN json_build_object(
        'ok', false,
        'erro', 'Esse ponto fica fora da área de entrega da loja. Fale com a loja pelo chat.');
    END IF;
  END IF;

  UPDATE pedidos_delivery
     SET endereco_lat = p_lat,
         endereco_lng = p_lng,
         endereco_pin_corrigido_em = now()
   WHERE id = p_pedido_id;

  -- Leva o acerto pro cadastro: o próximo pedido já nasce com o ponto certo.
  -- Marca como manual porque quem apontou foi o cliente — é o único pino em que
  -- o cálculo de taxa pode confiar (mig 0160).
  v_tel := regexp_replace(coalesce(v_ped.cliente_telefone, ''), '\D', '', 'g');
  v_ref := chave_endereco(v_ped.endereco_rua, v_ped.endereco_numero,
                          v_ped.endereco_bairro, v_ped.endereco_cidade);
  IF v_tel <> '' THEN
    UPDATE clientes SET
      endereco_lat        = p_lat,
      endereco_lng        = p_lng,
      endereco_pin_manual = true,
      endereco_pin_ref    = v_ref,
      endereco_pin_em     = now()
    WHERE empresa_id = v_ped.empresa_id
      AND regexp_replace(coalesce(telefone, ''), '\D', '', 'g') = v_tel;
  END IF;

  RETURN json_build_object('ok', true, 'lat', p_lat, 'lng', p_lng);
END;
$$;

REVOKE ALL ON FUNCTION public.corrigir_pin_pedido(uuid, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.corrigir_pin_pedido(uuid, double precision, double precision)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
