-- =========================================================
-- 0227: busca de produto pelo nome, pro WhatsApp responder
-- =========================================================
-- Depois do link, a pergunta que mais chega é a mais simples: "tem coca 2
-- litros?", "quanto é a quentinha?". Hoje isso ou fica sem resposta (robô
-- desligado) ou custa uma chamada de IA com o cardápio inteiro no prompt.
--
-- Não precisa de IA nenhuma: é procurar o nome no cardápio. Aqui, no banco,
-- com unaccent — porque o cliente escreve "acai" e o produto está cadastrado
-- como "Açaí", e um ilike simples não casa isso.
--
-- Ordena pelo mais parecido (pg_trgm) e devolve poucos: a resposta no WhatsApp
-- tem que caber em três linhas.
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
    AND unaccent(lower(p.nome)) LIKE '%' || unaccent(lower(btrim(p_termo))) || '%'
  -- Nome mais curto primeiro: quem pergunta "coca" quer a Coca-Cola, não a
  -- "Coca-Cola Zero Limão Pack com 6" — e o mais parecido vem antes.
  ORDER BY similarity(unaccent(lower(p.nome)), unaccent(lower(btrim(p_termo)))) DESC,
           length(p.nome) ASC
  LIMIT GREATEST(1, LEAST(p_limite, 5));
$$;

GRANT EXECUTE ON FUNCTION public.buscar_produto_nome(uuid, text, int) TO anon, authenticated, service_role;
