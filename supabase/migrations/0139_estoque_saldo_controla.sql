-- 0139_estoque_saldo_controla.sql
-- Expõe controla_estoque na view estoque_saldo pra a tela de Estoque poder esconder
-- os produtos SEM controle de estoque (que não deviam aparecer no "Saldo por produto").
-- A view continua trazendo TODOS os produtos (o cardápio online usa o saldo daqui);
-- quem filtra é a tela, no cliente.

CREATE OR REPLACE VIEW public.estoque_saldo AS
 SELECT p.id AS produto_id,
    p.nome,
    p.categoria,
    p.estoque_minimo,
    COALESCE(sum(
        CASE
            WHEN m.tipo = 'entrada'::text THEN m.quantidade
            WHEN m.tipo = 'saida'::text THEN - m.quantidade
            WHEN m.tipo = 'ajuste'::text THEN m.quantidade
            ELSE 0::numeric
        END), 0::numeric) AS quantidade_atual,
    p.controla_estoque
   FROM produtos p
     LEFT JOIN estoque_movimentos m ON m.produto_id = p.id
  WHERE p.empresa_id = current_empresa_id()
  GROUP BY p.id, p.nome, p.categoria, p.estoque_minimo, p.controla_estoque;
