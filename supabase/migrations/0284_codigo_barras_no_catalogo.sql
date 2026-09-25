-- 0284_codigo_barras_no_catalogo.sql
-- O Salão lê o cardápio pela view estoque_catalogo, não pela tabela de produtos.
-- Sem o código aqui, bipar funcionava na Nova venda e não funcionava na mesa.
-- Coluna nova vai no FIM da lista: CREATE OR REPLACE VIEW não deixa mexer na
-- ordem nem no tipo das que já existem.
CREATE OR REPLACE VIEW public.estoque_catalogo AS
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
    p.codigo_barras
   FROM produtos p
     JOIN empresas e ON e.id = p.empresa_id AND (e.status = ANY (ARRAY['trial'::text, 'ativo'::text, 'atrasado'::text]))
     LEFT JOIN estoque_movimentos m ON m.produto_id = p.id AND m.empresa_id = p.empresa_id
  WHERE p.ativo = true
  GROUP BY p.id, p.empresa_id, e.nome, p.nome, p.categoria, p.embalagem, p.unidades_por_caixa,
           p.preco_venda, p.estoque_minimo, p.controla_casco, p.foto_url, p.descricao,
           p.disponivel_delivery, p.ordem, p.preco_promocional, p.codigo_barras;

NOTIFY pgrst, 'reload schema';
