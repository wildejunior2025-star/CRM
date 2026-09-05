-- 0241_cidades_que_a_loja_atende.sql
-- A busca de rua do checkout procura numa cidade só: a da loja. Loja de divisa
-- entrega nas duas — a CDBom fica em São Gonçalo do Amarante e metade da
-- freguesia dela é de Natal. Uma cliente digitou "Rua Sebastiana Andrade", que
-- existe em Natal (CEP 59115-673), e a lista devolveu "Rua Sebastiana Benevides
-- de Oliveira", de São Gonçalo. Do lado dela não havia pista nenhuma do que
-- estava errado: a rua certa simplesmente não existia na lista.
--
-- Esta função diz em que cidades a loja JÁ entregou. Não é palpite nem cadastro
-- novo pra alguém preencher: é o histórico dela mesma. O checkout usa como
-- segunda tentativa quando a rua não aparece na cidade principal.
--
-- Devolve só nomes de cidade — nada de cliente, endereço ou pedido — por isso
-- pode ser chamada pelo anônimo do checkout, que é quem precisa dela.
CREATE OR REPLACE FUNCTION public.cidades_que_a_loja_atende(p_empresa_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(cidade ORDER BY vezes DESC), '{}')
  FROM (
    SELECT btrim(pd.endereco_cidade) AS cidade, count(*) AS vezes
    FROM pedidos_delivery pd
    WHERE pd.empresa_id = p_empresa_id
      AND pd.status <> 'cancelado'
      AND coalesce(pd.tipo_entrega, 'entrega') <> 'retirada'
      AND coalesce(btrim(pd.endereco_cidade), '') <> ''
      AND btrim(pd.endereco_cidade) <> 'Retirada'
      AND pd.created_at > now() - interval '180 days'
    GROUP BY 1
    HAVING count(*) >= 1
    ORDER BY count(*) DESC
    LIMIT 6
  ) t;
$$;

REVOKE ALL ON FUNCTION public.cidades_que_a_loja_atende(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cidades_que_a_loja_atende(uuid) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
