-- 0161_recupera_pinos_do_historico.sql
-- Recupera os pinos que os clientes JÁ apontaram e que o sistema tinha jogado
-- fora (ver 0160). Não inventa nada: só copia pro cadastro o ponto de um pedido
-- que aquele mesmo cliente fez, quando o endereço ainda é o mesmo.
--
-- Como se sabe que o pino foi apontado à mão: a quantidade de casas decimais.
--   buscador de mapa (Nominatim) → sempre 7 casas   (-5.7377259)
--   pino arrastado / GPS         → 14+ casas        (-5.76576576576577)
--   iFood                        → 6 casas
-- O buscador devolve o MESMO valor pro mesmo texto, então 7 casas repetidas não
-- valem nada. Só entram aqui os de mais de 8 casas.

-- ── 1) Endereço idêntico (rua + número + bairro + cidade) ───────────────────
WITH manuais AS (
  SELECT DISTINCT ON (pd.cliente_id)
    pd.cliente_id, pd.endereco_lat AS lat, pd.endereco_lng AS lng, pd.created_at,
    chave_endereco(pd.endereco_rua, pd.endereco_numero, pd.endereco_bairro, pd.endereco_cidade) AS ref
  FROM pedidos_delivery pd
  WHERE pd.cliente_id IS NOT NULL
    AND pd.endereco_lat IS NOT NULL
    AND length(split_part(trim(trailing '0' FROM pd.endereco_lat::text), '.', 2)) > 8
  ORDER BY pd.cliente_id, pd.created_at DESC   -- o mais recente que ele apontou
)
UPDATE clientes c SET
  endereco_lat = m.lat, endereco_lng = m.lng,
  endereco_pin_manual = true,
  endereco_pin_ref = m.ref,
  endereco_pin_em = m.created_at
FROM manuais m
WHERE c.id = m.cliente_id
  AND m.ref IS NOT NULL
  AND m.ref = chave_endereco(c.endereco, c.numero, c.bairro, c.cidade)
  AND c.endereco_pin_manual IS NOT TRUE;   -- nunca por cima de pino mais novo

-- ── 2) Mesma rua/número/cidade, só o BAIRRO escrito diferente ───────────────
-- O bairro é o campo que o cliente mais digita de um jeito diferente a cada
-- pedido ("Potengi", "Panatis _1", "Nossa Senhora da Apresentação" pra mesma
-- casa). Rua + número + cidade batendo, é a mesma casa — e o pino que ele
-- apontou continua valendo. Sem isto o caso que originou tudo isto (Av. das
-- Fronteiras 400, cobrado R$ 8 em vez de R$ 4) ficaria de fora.
WITH manuais AS (
  SELECT DISTINCT ON (pd.cliente_id)
    pd.cliente_id, pd.endereco_lat AS lat, pd.endereco_lng AS lng, pd.created_at,
    pd.endereco_rua AS rua, pd.endereco_numero AS num, pd.endereco_cidade AS cid
  FROM pedidos_delivery pd
  WHERE pd.cliente_id IS NOT NULL
    AND pd.endereco_lat IS NOT NULL
    AND length(split_part(trim(trailing '0' FROM pd.endereco_lat::text), '.', 2)) > 8
  ORDER BY pd.cliente_id, pd.created_at DESC
)
UPDATE clientes c SET
  endereco_lat = m.lat, endereco_lng = m.lng,
  endereco_pin_manual = true,
  -- Grava a chave do endereço ATUAL do cadastro: é com essa que o checkout vai
  -- comparar. Gravar a do pedido velho faria o pino nunca casar.
  endereco_pin_ref = chave_endereco(c.endereco, c.numero, c.bairro, c.cidade),
  endereco_pin_em = m.created_at
FROM manuais m
WHERE c.id = m.cliente_id
  AND c.endereco_pin_manual IS NOT TRUE
  AND chave_endereco(m.rua, m.num, NULL, m.cid) IS NOT NULL
  AND chave_endereco(m.rua, m.num, NULL, m.cid) = chave_endereco(c.endereco, c.numero, NULL, c.cidade);
