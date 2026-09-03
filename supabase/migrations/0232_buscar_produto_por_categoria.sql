-- =========================================================
-- 0232: o robô também procura pela CATEGORIA
-- =========================================================
-- "tem refrigerante ?" caiu em "Essa eu não sei te responder" numa loja que
-- vende Coca, Guaraná e Fanta. O motivo: a busca olhava só o NOME do produto, e
-- nenhum produto se chama "refrigerante" — é o nome da categoria.
--
-- Vale pra quase toda pergunta de balcão: refrigerante, sorvete, salgado,
-- picolé, sobremesa. O cliente pergunta pela prateleira, não pela etiqueta.
-- =========================================================

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
  SELECT p.id, p.nome, COALESCE(p.preco_venda, 0), p.categoria
  FROM produtos p
  WHERE p.empresa_id = p_empresa
    AND p.ativo
    AND p.disponivel_delivery
    AND p.arquivado_em IS NULL
    AND length(btrim(p_termo)) >= 3
    AND (
      unaccent(lower(p.nome)) LIKE '%' || unaccent(lower(btrim(p_termo))) || '%'
      OR unaccent(lower(COALESCE(p.categoria, ''))) LIKE '%' || unaccent(lower(btrim(p_termo))) || '%'
    )
  -- Casou no nome vem antes de casou na categoria; entre iguais, o nome mais
  -- curto e mais parecido primeiro (quem pergunta "coca" quer a Coca-Cola, não
  -- a "Coca-Cola Zero Limão Pack com 6").
  ORDER BY GREATEST(
             similarity(unaccent(lower(p.nome)), unaccent(lower(btrim(p_termo)))),
             similarity(unaccent(lower(COALESCE(p.categoria, ''))), unaccent(lower(btrim(p_termo)))) * 0.9
           ) DESC,
           length(p.nome) ASC
  LIMIT GREATEST(1, LEAST(p_limite, 60));
$$;

GRANT EXECUTE ON FUNCTION public.buscar_produto_nome(uuid, text, int) TO anon, authenticated, service_role;
