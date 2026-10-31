-- 0435_pedido_do_link_mostra_preco_e_complemento.sql
-- O cartão do pedido no link do cliente (mig 0434) mostrava "R$ 0,00" no item e
-- escondia os sabores.
--
-- POR QUÊ: o `itens` do pedido de delivery não tem um formato só. O catálogo
-- grava `quantidade`/`subtotal`; a sacola do robô grava `qtd`/`preco`, e os
-- sabores ficam numa lista `complementos` dentro do item. Lendo só `subtotal` e
-- `quantidade`, a pizza "monte a sua" do pedido #1006 da demo aparecia por
-- R$ 0,00 e sem os dois sabores que o cliente escolheu.
--
-- Agora o valor do item cai em cascata (subtotal → preco_unitario × qtd →
-- preco × qtd → 0), os complementos vêm junto, e o pedido traz a taxa de
-- entrega e o desconto: sem isso a soma dos itens não fechava com o total e
-- parecia cobrança errada.

CREATE OR REPLACE FUNCTION public.cliente_pedidos(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cli clientes%ROWTYPE;
  v_tel text;
BEGIN
  SELECT * INTO v_cli FROM clientes WHERE token = p_token;
  IF v_cli.id IS NULL THEN RAISE EXCEPTION 'Link não encontrado.'; END IF;

  v_tel := regexp_replace(COALESCE(v_cli.telefone, ''), '\D', '', 'g');
  IF length(v_tel) < 10 THEN v_tel := NULL; END IF;

  RETURN COALESCE((
    SELECT json_agg(json_build_object(
             'id',       p.id,
             'numero',   p.numero_pedido,
             'status',   p.status,
             'tipo',     p.tipo_entrega,
             'forma',    p.forma_pagamento,
             'total',    p.total,
             'taxa',     COALESCE(p.taxa_entrega, 0),
             'desconto', COALESCE(p.desconto, 0) + COALESCE(p.cashback_usado, 0),
             'quando',   p.created_at,
             'itens',  (SELECT COALESCE(json_agg(json_build_object(
                                 'nome',       i->>'nome',
                                 'quantidade', COALESCE((i->>'quantidade')::numeric, (i->>'qtd')::numeric, 1),
                                 'valor',      COALESCE(
                                                 (i->>'subtotal')::numeric,
                                                 (i->>'preco_unitario')::numeric * COALESCE((i->>'quantidade')::numeric, (i->>'qtd')::numeric, 1),
                                                 (i->>'preco')::numeric * COALESCE((i->>'qtd')::numeric, (i->>'quantidade')::numeric, 1),
                                                 0),
                                 'complementos', (SELECT COALESCE(json_agg(json_build_object(
                                                           'nome', c->>'nome',
                                                           'qtd',  COALESCE((c->>'qtd')::numeric, 1))), '[]'::json)
                                                    FROM jsonb_array_elements(
                                                           CASE WHEN jsonb_typeof(i->'complementos') = 'array'
                                                                THEN i->'complementos' ELSE '[]'::jsonb END) c)
                               )), '[]'::json)
                          FROM jsonb_array_elements(COALESCE(p.itens, '[]'::jsonb)) i)
           ) ORDER BY p.created_at DESC)
    FROM (
      SELECT d.*
        FROM pedidos_delivery d
       WHERE d.empresa_id = v_cli.empresa_id
         AND (d.cliente_id = v_cli.id
              OR (v_tel IS NOT NULL
                  AND regexp_replace(COALESCE(d.cliente_telefone, ''), '\D', '', 'g') = v_tel))
       ORDER BY d.created_at DESC
       LIMIT 15
    ) p
  ), '[]'::json);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_pedidos(text) FROM public;
GRANT EXECUTE ON FUNCTION public.cliente_pedidos(text) TO anon, authenticated;
