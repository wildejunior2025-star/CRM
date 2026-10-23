-- O cardápio precisa saber o que é vendido por quilo (23/10/2026)
--
-- O Salão monta o cardápio da mesa a partir da view estoque_catalogo, e ela
-- não trazia `vendido_por_peso`. Sem esse campo, o produto de quilo aparecia
-- na lista normal junto com os outros — e um toque nele lançava "1 × R$ 54,99"
-- em vez do peso.
--
-- O garçom não erraria por desatenção: erraria porque o botão estava lá e
-- parecia certo. O Agv tem TRÊS pratos por quilo (self service, proteínas,
-- carne assada) com preços diferentes, então eram três botões armados.
--
-- Coluna nova vai no FIM da lista de propósito: `create or replace view` só
-- aceita acrescentar no fim — mudar a ordem das colunas exige derrubar a view,
-- e derrubar uma view que o cardápio inteiro usa no meio do almoço não é coisa
-- que se faça por organização.
create or replace view public.estoque_catalogo as
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
    p.vendido_por_peso
   FROM produtos p
     JOIN empresas e ON e.id = p.empresa_id AND (e.status = ANY (ARRAY['trial'::text, 'ativo'::text, 'atrasado'::text]))
     LEFT JOIN estoque_movimentos m ON m.produto_id = p.id AND m.empresa_id = p.empresa_id
  WHERE p.ativo = true
  GROUP BY p.id, p.empresa_id, e.nome, p.nome, p.categoria, p.embalagem, p.unidades_por_caixa,
           p.preco_venda, p.estoque_minimo, p.controla_casco, p.foto_url, p.descricao,
           p.disponivel_delivery, p.ordem, p.preco_promocional, p.codigo_barras, p.faixas_preco,
           p.vendido_por_peso;
