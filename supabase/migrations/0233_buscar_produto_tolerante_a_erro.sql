-- 0233: a busca de produto passa a perdoar erro de digitação.
--
-- "Galioto" escrito "Galiotto" não achava nada e o robô dizia que a loja não
-- tem. O LIKE exige as letras exatas; aqui, quando o LIKE não acha NADA, entra
-- a similaridade (pg_trgm) — a mesma que já ordenava o resultado.
--
-- Vale pro robô e pro atendente: é a mesma função que a busca dentro da
-- conversa usa quando alguém assume o atendimento.
CREATE OR REPLACE FUNCTION public.buscar_produto_nome(
  p_empresa uuid,
  p_termo   text,
  p_limite  int DEFAULT 3
)
RETURNS TABLE (id uuid, nome text, preco numeric, categoria text)
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
           similarity(unaccent(lower(p.nome)), (SELECT t FROM termo)) AS score
    FROM produtos p
    WHERE NOT EXISTS (SELECT 1 FROM exatos)
      AND p.empresa_id = p_empresa
      AND p.ativo AND p.disponivel_delivery AND p.arquivado_em IS NULL
      AND length((SELECT t FROM termo)) >= 4
      AND similarity(unaccent(lower(p.nome)), (SELECT t FROM termo)) >= 0.3
  )
  SELECT id, nome, preco, categoria FROM (
    SELECT * FROM exatos
    UNION ALL
    SELECT * FROM parecidos
  ) tudo
  ORDER BY score DESC, length(nome) ASC
  LIMIT GREATEST(1, LEAST(p_limite, 60));
$$;

GRANT EXECUTE ON FUNCTION public.buscar_produto_nome(uuid, text, int) TO anon, authenticated, service_role;
