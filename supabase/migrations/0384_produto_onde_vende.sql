-- 0384 — Onde cada PRODUTO vende (e não mais a categoria inteira)
--
-- Até aqui o "só no salão" era da categoria (0328). Só que numa mesma categoria
-- tem item que a loja quer vender em todo canto e item que só vende no salão —
-- e o único jeito era criar categoria separada. O sistema que a loja usava antes
-- tinha uma chave por produto, por canal. Passa a ser assim:
--
--   vende_salao   garçom, balcão e PDV do gestor (a equipe)
--   vende_mesa    QR da mesa e link do cliente na mesa
--   vende_online  Loja Online e robô do WhatsApp
--   vende_app     app do cliente (Play Store / iPhone)
--
-- Tudo nasce ligado. "Pausar" continua existindo e tira o produto de todos os
-- canais (ativo = false).

ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS vende_salao  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS vende_mesa   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS vende_online boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS vende_app    boolean NOT NULL DEFAULT true;

-- Traz o que já estava marcado na categoria ("só no salão" = fora da Loja Online,
-- do app e do robô) pra dentro de cada produto dela.
UPDATE produtos p
   SET vende_online = false, vende_app = false
  FROM categorias c
 WHERE c.empresa_id = p.empresa_id AND c.nome = p.categoria AND c.oculta_online;

-- A marca da categoria sai (a tela dela não existe mais), EXCETO nas categorias
-- "só iFood": ali ela é mantida pela integração — produto novo que o iFood trouxer
-- pra categoria nasce com vende_online ligado e não pode vazar pra Loja Online.
UPDATE categorias SET oculta_online = false WHERE oculta_online AND NOT COALESCE(so_ifood, false);

-- O catálogo que mesa, salão, app e loja leem precisa conhecer as chaves.
CREATE OR REPLACE VIEW estoque_catalogo AS
 SELECT p.id AS produto_id,
    p.empresa_id,
    e.nome AS empresa_nome,
    p.nome,
    p.categoria,
    p.embalagem,
    p.unidades_por_caixa,
    p.preco_venda,
    p.estoque_minimo,
    p.controla_casco,
    p.foto_url,
    p.descricao,
    COALESCE(sum(
        CASE
            WHEN m.tipo = 'entrada'::text THEN m.quantidade
            WHEN m.tipo = 'saida'::text THEN - m.quantidade
            WHEN m.tipo = 'ajuste'::text THEN m.quantidade
            ELSE 0::numeric
        END), 0::numeric) AS quantidade_atual,
    p.disponivel_delivery,
    p.ordem,
    p.preco_promocional,
    p.codigo_barras,
    p.faixas_preco,
    p.vendido_por_peso,
    p.vende_salao,
    p.vende_mesa,
    p.vende_online,
    p.vende_app
   FROM produtos p
     JOIN empresas e ON e.id = p.empresa_id AND (e.status = ANY (ARRAY['trial'::text, 'ativo'::text, 'atrasado'::text]))
     LEFT JOIN estoque_movimentos m ON m.produto_id = p.id AND m.empresa_id = p.empresa_id
  WHERE p.ativo = true
  GROUP BY p.id, p.empresa_id, e.nome, p.nome, p.categoria, p.embalagem, p.unidades_por_caixa, p.preco_venda, p.estoque_minimo, p.controla_casco, p.foto_url, p.descricao, p.disponivel_delivery, p.ordem, p.preco_promocional, p.codigo_barras, p.faixas_preco, p.vendido_por_peso, p.vende_salao, p.vende_mesa, p.vende_online, p.vende_app;

-- As buscas do robô do WhatsApp só acham o que vende online. Reescreve as três
-- funções a partir da própria definição (troca o filtro de delivery pelo
-- delivery + vende_online), pra não copiar o corpo delas aqui.
DO $$
DECLARE
  f record;
  v_def text;
BEGIN
  FOR f IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('buscar_produto_cardapio', 'buscar_produto_nome')
  LOOP
    v_def := pg_get_functiondef(f.oid);
    IF v_def NOT LIKE '%vende_online%' THEN
      v_def := replace(v_def, 'p.disponivel_delivery', 'p.disponivel_delivery AND p.vende_online');
      EXECUTE v_def;
    END IF;
  END LOOP;
END $$;
