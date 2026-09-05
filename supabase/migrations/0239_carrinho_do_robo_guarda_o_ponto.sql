-- 0239_carrinho_do_robo_guarda_o_ponto.sql
-- O robô passa a pedir a LOCALIZAÇÃO e o pedido dele nasce com o ponto.
--
-- Até aqui o robô perguntava CEP ou endereço escrito, e o pedido que ele criava
-- não levava coordenada nenhuma (o `pedidoPayload` do whatsapp-webhook só tinha
-- texto). Ou seja: o robô era o único caminho da casa que continuava mandando o
-- motoboy atrás de um pino chutado pelo buscador de mapa.
--
-- Agora o primeiro pedido é o pininho do WhatsApp. Ele chega com lat/lng, o
-- sistema lê a rua/bairro/cidade de volta pelo mapa, e só sobra perguntar o
-- NÚMERO — que GPS não sabe dizer. Quem não souber mandar localização continua
-- com o caminho de sempre: CEP ou endereço escrito, inteiro, sem mudança.
--
-- O ponto mora no carrinho enquanto a conversa acontece; quando o pedido fecha
-- ele vai pro `pedidos_delivery.endereco_lat/lng`, que é o que o app do
-- entregador abre.

ALTER TABLE public.whatsapp_carrinho
  ADD COLUMN IF NOT EXISTS endereco_lat double precision,
  ADD COLUMN IF NOT EXISTS endereco_lng double precision;

COMMENT ON COLUMN public.whatsapp_carrinho.endereco_lat IS
  'Ponto da entrega enquanto a conversa rola (mig 0239). Veio da localização que '
  'o cliente mandou no WhatsApp; vai pro pedido no fechamento.';

NOTIFY pgrst, 'reload schema';

-- ── salvar_pino_do_cliente ───────────────────────────────────────────────────
-- Grava o ponto no cadastro do cliente e monta a `endereco_pin_ref` a partir do
-- endereço que JÁ está no cadastro dele. A ref é calculada aqui, em SQL, pela
-- mesma `chave_endereco` que o resto do sistema usa pra decidir se um pino ainda
-- vale (mig 0162) — se o robô montasse essa chave por conta própria, bastaria
-- uma diferença de acento pra o pino certo parar de casar e a taxa voltar pro
-- buscador de mapa.
--
-- Chamada pelo robô (service_role) logo depois de gravar o número da casa, que
-- é quando o endereço fica completo. Antes disso a ref sairia sem o número e
-- não casaria com nada.
CREATE OR REPLACE FUNCTION public.salvar_pino_do_cliente(
  p_empresa_id uuid,
  p_telefone   text,
  p_lat        double precision,
  p_lng        double precision
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_n   int;
BEGIN
  IF p_lat IS NULL OR p_lng IS NULL OR v_tel = '' THEN RETURN false; END IF;

  UPDATE clientes SET
    endereco_lat        = p_lat,
    endereco_lng        = p_lng,
    endereco_pin_manual = true,
    endereco_pin_origem = 'cliente',
    endereco_pin_ref    = chave_endereco(endereco, numero, bairro, cidade),
    endereco_pin_em     = now()
  WHERE empresa_id = p_empresa_id
    AND regexp_replace(coalesce(telefone, ''), '\D', '', 'g') LIKE '%' || right(v_tel, 8);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.salvar_pino_do_cliente(uuid, text, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.salvar_pino_do_cliente(uuid, text, double precision, double precision) TO service_role;

NOTIFY pgrst, 'reload schema';
