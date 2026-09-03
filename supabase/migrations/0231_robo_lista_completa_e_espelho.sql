-- =========================================================
-- 0231: o robô mostra o cardápio inteiro, e o gestor vê a conversa inteira
-- =========================================================
-- 1) A busca de produto nascia com teto de 5 (0227) porque "a resposta tem que
--    caber em três linhas". Na prática o cliente perguntou "tem suco?", levou 3
--    e teve que perguntar "só tem isso?". É o mesmo erro do atendente que fala
--    3 sabores de polpa: na cabeça do cliente a loja SÓ tem aqueles três.
--    Quem pergunta quer ver tudo o que tem — o teto sobe.
--
-- 2) O robô responde no WhatsApp, mas o espelho no gestor (aba Mensagens) só
--    copiava a fala do CLIENTE. A loja abria a conversa e via as perguntas sem
--    as respostas — parecia que ninguém tinha respondido. Agora a fala do robô
--    entra também, marcada como dele.
-- =========================================================

ALTER TABLE public.mensagens_chat
  ADD COLUMN IF NOT EXISTS bot boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.mensagens_chat.bot IS
  'Mensagem escrita pelo robô do WhatsApp (entra como remetente=loja, mas quem falou foi ele).';

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
  LIMIT GREATEST(1, LEAST(p_limite, 60));
$$;

GRANT EXECUTE ON FUNCTION public.buscar_produto_nome(uuid, text, int) TO anon, authenticated, service_role;
