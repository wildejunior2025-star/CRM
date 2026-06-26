-- =========================================================
-- 0059: Cliente do QR acompanha a comanda da mesa
-- =========================================================
-- mesa_comanda(token) → itens da comanda aberta da mesa (com status),
-- subtotal e a % de taxa de serviço, para o cliente acompanhar o que
-- pediu, ver quando a cozinha marca pronto e quanto vai pagar.
-- SECURITY DEFINER + anon (cliente sem login).
-- =========================================================
CREATE OR REPLACE FUNCTION public.mesa_comanda(p_token text)
RETURNS json
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT json_build_object(
    'comanda_id', c.id,
    'taxa_pct', COALESCE(e.taxa_servico_pct, 0),
    'subtotal', COALESCE((SELECT SUM(ci.preco_unitario * ci.quantidade)
                          FROM comanda_itens ci WHERE ci.comanda_id = c.id), 0),
    'itens', COALESCE((
      SELECT json_agg(json_build_object(
               'id', ci.id, 'nome', ci.nome, 'quantidade', ci.quantidade,
               'preco', ci.preco_unitario, 'status', ci.status, 'observacao', ci.observacao
             ) ORDER BY ci.created_at)
      FROM comanda_itens ci WHERE ci.comanda_id = c.id), '[]'::json)
  )
  FROM mesas m
  JOIN empresas e  ON e.id = m.empresa_id
  JOIN comandas c  ON c.mesa_id = m.id AND c.status = 'aberta'
  WHERE m.token = p_token
  ORDER BY c.created_at
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION mesa_comanda(text) FROM public;
GRANT  EXECUTE ON FUNCTION mesa_comanda(text) TO anon, authenticated;
