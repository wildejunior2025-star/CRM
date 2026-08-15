-- 0163_marcar_pino_suspeito.sql
-- Marca pra RECONFIRMAR o endereço todo cliente cujo ponto briga com o resto da
-- rua dele. No próximo pedido o mapa vai exigir o dedo dele (0160/0162), e aí o
-- ponto certo passa a valer pra sempre.
--
-- A régua é o iFood: as coordenadas que vêm de lá são do app deles, não do
-- buscador que a gente usa, então servem de gabarito de onde cada rua fica.
-- Se o ponto do pedido próprio está a mais de 1,2 km da mediana da MESMA rua
-- no iFood, o pino está errado — foi assim que apareceu o caso da Av. das
-- Fronteiras 400 (3,08 km gravados, 1,09 km de verdade, R$ 8 em vez de R$ 4).
--
-- Não inventa coordenada nenhuma: só liga o flag que obriga o cliente a apontar.
-- Falso positivo custa barato (arrastar o pino uma vez); falso negativo custa
-- cliente pagando a mais em todo pedido, calado.

WITH n AS (
  SELECT pd.empresa_id, pd.cliente_id, pd.origem, pd.endereco_lat, pd.endereco_lng,
    6371*2*asin(sqrt(power(sin(radians(pd.endereco_lat - e.latitude::float8)/2),2)
      + cos(radians(e.latitude::float8))*cos(radians(pd.endereco_lat))
      * power(sin(radians(pd.endereco_lng - e.longitude::float8)/2),2))) AS km,
    btrim(regexp_replace(regexp_replace(lower(unaccent(coalesce(pd.endereco_rua,''))),
      '^(av\.?|avenida|r\.?|rua|tv\.?|travessa|al\.?|alameda)\s+','','g'),'[^a-z0-9 ]',' ','g')) AS ruakey
  FROM pedidos_delivery pd
  JOIN empresas e ON e.id = pd.empresa_id
  WHERE pd.status <> 'cancelado'
    AND pd.endereco_lat IS NOT NULL
    AND coalesce(pd.tipo_entrega,'entrega') <> 'retirada'
    AND e.latitude IS NOT NULL
),
ref AS (   -- onde a rua fica, segundo o iFood
  SELECT empresa_id, ruakey,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY km) AS km_ref
  FROM n WHERE origem = 'ifood' AND ruakey <> ''
  GROUP BY 1,2 HAVING count(*) >= 2
),
suspeitos AS (
  SELECT DISTINCT n.cliente_id
  FROM n JOIN ref r ON r.empresa_id = n.empresa_id AND r.ruakey = n.ruakey
  WHERE n.origem <> 'ifood'
    AND n.cliente_id IS NOT NULL
    AND n.km - r.km_ref > 1.2          -- só quando o pino jogou o cliente pra LONGE
)
UPDATE clientes c
SET reconfirmar_endereco = true
FROM suspeitos s
WHERE c.id = s.cliente_id
  AND c.endereco_pin_manual IS NOT TRUE   -- quem já apontou à mão está resolvido
  AND c.reconfirmar_endereco IS NOT TRUE;
