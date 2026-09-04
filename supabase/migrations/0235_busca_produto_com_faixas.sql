-- 0235: a busca de produto devolve também as faixas de atacado e a promoção.
--
-- A sacola que o atendente monta dentro da conversa cobrava sempre o preço
-- cheio: 10 picolés de R$ 1,50 fechavam R$ 15,00, mesmo com a faixa "a partir
-- de 10 sai a R$ 0,65" cadastrada. A tela de Vender já respeita a faixa; a
-- sacola não tinha como — a busca só devolvia id, nome, preço e categoria.
--
-- Com `faixas_preco` e `preco_promocional` na resposta, a sacola faz a mesma
-- conta da Vender e da Loja Online (src/lib/precoQuantidade.js), e ainda mostra
-- o degrau na lista ("10+ R$ 0,65") antes de bater a quantidade.
--
-- Colunas novas no fim: o robô só lê `id` do resultado, então nada quebra.
DROP FUNCTION IF EXISTS public.buscar_produto_nome(uuid, text, int);

CREATE FUNCTION public.buscar_produto_nome(
  p_empresa uuid,
  p_termo   text,
  p_limite  int DEFAULT 3
)
RETURNS TABLE (
  id uuid, nome text, preco numeric, categoria text,
  faixas_preco jsonb, preco_promocional numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH termo AS (
    SELECT unaccent(lower(btrim(p_termo))) AS t
  ),
  exatos AS (
    SELECT p.id, p.nome, COALESCE(p.preco_venda, 0) AS preco, p.categoria,
           p.faixas_preco, p.preco_promocional,
           GREATEST(
             similarity(unaccent(lower(p.nome)), (SELECT t FROM termo)),
             similarity(unaccent(lower(COALESCE(p.categoria, ''))), (SELECT t FROM termo)) * 0.9
           ) AS score
    FROM produtos p
    WHERE p.empresa_id = p_empresa
      AND p.ativo AND p.disponivel_delivery AND p.arquivado_em IS NULL
      AND length((SELECT t FROM termo)) >= 3
      AND (
        unaccent(lower(p.nome)) LIKE '%' || (SELECT t FROM termo) || '%'
        OR unaccent(lower(COALESCE(p.categoria, ''))) LIKE '%' || (SELECT t FROM termo) || '%'
      )
  ),
  parecidos AS (
    -- Só entra quando o LIKE não achou nada: é a rede pra quem digitou errado.
    SELECT p.id, p.nome, COALESCE(p.preco_venda, 0) AS preco, p.categoria,
           p.faixas_preco, p.preco_promocional,
           similarity(unaccent(lower(p.nome)), (SELECT t FROM termo)) AS score
    FROM produtos p
    WHERE NOT EXISTS (SELECT 1 FROM exatos)
      AND p.empresa_id = p_empresa
      AND p.ativo AND p.disponivel_delivery AND p.arquivado_em IS NULL
      AND length((SELECT t FROM termo)) >= 4
      AND similarity(unaccent(lower(p.nome)), (SELECT t FROM termo)) >= 0.3
  )
  SELECT id, nome, preco, categoria, faixas_preco, preco_promocional FROM (
    SELECT * FROM exatos
    UNION ALL
    SELECT * FROM parecidos
  ) tudo
  ORDER BY score DESC, length(nome) ASC
  LIMIT GREATEST(1, LEAST(p_limite, 60));
$$;

GRANT EXECUTE ON FUNCTION public.buscar_produto_nome(uuid, text, int) TO anon, authenticated, service_role;
