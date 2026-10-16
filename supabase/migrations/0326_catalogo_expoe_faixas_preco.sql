-- FAIXA DE ATACADO NO CATÁLOGO DO SALÃO (15/10/2026)
--
-- `faixas_preco` ("a partir de 20 sai a R$ 0,50") existia em produtos e já era
-- aplicada na Nova venda, na Loja Online e no robô — mas NÃO na mesa. O relato:
-- 20 Pine Vermelho na comanda saíram a R$ 0,75 cada (R$ 15,00) em vez dos
-- R$ 0,50 da faixa (R$ 10,00).
--
-- A causa de raiz é aqui: o Salão lê o cardápio desta view, e ela não devolvia
-- `faixas_preco`. A tela nem tinha o dado pra aplicar. (`preco_promocional` já
-- estava exposto, mas o Salão também não o selecionava — ver o front.)
--
-- Só acrescenta uma coluna; o resto da view é igual à mig 0284.

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
    p.codigo_barras,
    p.faixas_preco
   FROM produtos p
     JOIN empresas e ON e.id = p.empresa_id AND (e.status = ANY (ARRAY['trial'::text, 'ativo'::text, 'atrasado'::text]))
     LEFT JOIN estoque_movimentos m ON m.produto_id = p.id AND m.empresa_id = p.empresa_id
  WHERE p.ativo = true
  GROUP BY p.id, p.empresa_id, e.nome, p.nome, p.categoria, p.embalagem,
           p.unidades_por_caixa, p.preco_venda, p.estoque_minimo, p.controla_casco,
           p.foto_url, p.descricao, p.disponivel_delivery, p.ordem,
           p.preco_promocional, p.codigo_barras, p.faixas_preco;
