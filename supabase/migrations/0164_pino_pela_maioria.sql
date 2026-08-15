-- 0164_pino_pela_maioria.sql
-- Recupera o ponto certo de quem NUNCA arrastou o pino, usando a resposta que o
-- próprio sistema já deu — por maioria.
--
-- O buscador de mapa erra de vez em quando, não sempre. Pro mesmo endereço ele
-- devolveu 0,70 km duas vezes e 5,46 km uma vez (RAMON, R. Marcílio Dias 1153);
-- 1,03 km duas vezes e 4,67 km uma (ARLETE, R. Santa Luzia 1125, o furo foi
-- justamente hoje e custou R$ 5 a mais a ela, que é cliente de 13 pedidos).
-- A resposta repetida é a boa; a solitária é o tropeço.
--
-- Isto NÃO inventa coordenada: só escolhe, entre pontos que o sistema mesmo
-- gravou pra aquele endereço, o que ele repetiu. Exige maioria absoluta e pelo
-- menos 2 ocorrências.

-- De onde veio o pino que está valendo. `endereco_pin_manual` continua sendo
-- "confiável o bastante pra reusar e não deixar o buscador sobrescrever" — esta
-- coluna diz COMO ele ficou confiável, pra ninguém ler 'manual' e achar que o
-- cliente apontou quando não apontou.
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS endereco_pin_origem text;

COMMENT ON COLUMN public.clientes.endereco_pin_origem IS
  'cliente = arrastou/clicou/GPS. maioria = ponto que o buscador repetiu pro mesmo endereco (mig 0164).';
COMMENT ON COLUMN public.clientes.endereco_pin_manual IS
  'true = pino confiavel: reusado no checkout e nunca sobrescrito pelo buscador. Veja endereco_pin_origem pra saber a procedencia.';

UPDATE clientes SET endereco_pin_origem = 'cliente'
WHERE endereco_pin_manual = true AND endereco_pin_origem IS NULL;

WITH n AS (
  SELECT pd.cliente_id, pd.endereco_lat AS lat, pd.endereco_lng AS lng,
    chave_endereco(pd.endereco_rua, pd.endereco_numero, pd.endereco_bairro, pd.endereco_cidade) AS ref,
    count(*) OVER (PARTITION BY pd.cliente_id,
      chave_endereco(pd.endereco_rua, pd.endereco_numero, pd.endereco_bairro, pd.endereco_cidade),
      pd.endereco_lat, pd.endereco_lng) AS vezes,
    count(*) OVER (PARTITION BY pd.cliente_id,
      chave_endereco(pd.endereco_rua, pd.endereco_numero, pd.endereco_bairro, pd.endereco_cidade)) AS total,
    max(pd.created_at) OVER (PARTITION BY pd.cliente_id,
      chave_endereco(pd.endereco_rua, pd.endereco_numero, pd.endereco_bairro, pd.endereco_cidade),
      pd.endereco_lat, pd.endereco_lng) AS visto_em
  FROM pedidos_delivery pd
  WHERE pd.status <> 'cancelado'
    AND pd.endereco_lat IS NOT NULL
    AND coalesce(pd.tipo_entrega,'entrega') <> 'retirada'
    AND pd.cliente_id IS NOT NULL
),
maioria AS (
  SELECT DISTINCT cliente_id, ref, lat, lng, visto_em
  FROM n
  WHERE ref IS NOT NULL
    AND vezes >= 2                 -- repetiu, não foi resposta de um dia só
    AND vezes > total - vezes      -- maioria absoluta
    AND total > vezes              -- e houve divergência: é isso que estamos consertando
)
UPDATE clientes c SET
  endereco_lat = m.lat,
  endereco_lng = m.lng,
  endereco_pin_manual = true,
  endereco_pin_origem = 'maioria',
  endereco_pin_ref = m.ref,
  endereco_pin_em = m.visto_em,
  -- Com o ponto certo no lugar, não faz sentido obrigar o cliente a remarcar.
  -- Quem continua marcado é quem tem UM ponto só, e errado — pra esses o único
  -- jeito honesto é o cliente apontar.
  reconfirmar_endereco = false
FROM maioria m
WHERE c.id = m.cliente_id
  AND c.endereco_pin_manual IS NOT TRUE                  -- pino do cliente sempre ganha
  AND m.ref = chave_endereco(c.endereco, c.numero, c.bairro, c.cidade);
