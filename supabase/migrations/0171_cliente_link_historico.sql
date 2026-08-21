-- Histórico de compras no link do cliente.
--
-- A aba "Minha conta" só mostrava o fiado e os pagamentos. Quem paga na hora
-- (cartão, dinheiro, PIX) não via nada — e é justamente quem aparece dias
-- depois perguntando "o que foi essa cobrança na fatura?". Agora a RPC devolve
-- também 'historico': TODA compra do cliente, paga como for, com os itens.
--
-- Só acrescenta uma chave no JSON; nada do que já existia mudou.

CREATE OR REPLACE FUNCTION public.cliente_conta(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cli     clientes%ROWTYPE;
  v_comanda comandas%ROWTYPE;
BEGIN
  SELECT * INTO v_cli FROM clientes WHERE token = p_token;
  IF v_cli.id IS NULL THEN RAISE EXCEPTION 'Link não encontrado.'; END IF;

  SELECT * INTO v_comanda FROM comandas
  WHERE empresa_id = v_cli.empresa_id AND cliente_id = v_cli.id
    AND status IN ('aberta','aguardando_conferencia')
  ORDER BY created_at LIMIT 1;

  RETURN json_build_object(
    'cliente_nome', v_cli.nome,
    -- Comanda aberta agora (null se não tem pedido rolando)
    'comanda', CASE WHEN v_comanda.id IS NULL THEN NULL ELSE json_build_object(
      'id',       v_comanda.id,
      'numero',   v_comanda.numero_mesa,
      'status',   v_comanda.status,
      'subtotal', (SELECT COALESCE(SUM(preco_unitario * quantidade), 0)
                     FROM comanda_itens WHERE comanda_id = v_comanda.id),
      'itens',    (SELECT COALESCE(json_agg(json_build_object(
                            'id', i.id, 'nome', i.nome, 'quantidade', i.quantidade,
                            'preco', i.preco_unitario, 'status', i.status,
                            'observacao', i.observacao) ORDER BY i.created_at), '[]'::json)
                     FROM comanda_itens i WHERE i.comanda_id = v_comanda.id)
    ) END,
    -- Quanto ele deve hoje (mesma conta da tela do fiado da loja)
    'saldo_fiado', COALESCE((SELECT saldo_fiado FROM clientes_saldo_fiado WHERE cliente_id = v_cli.id), 0),
    -- O que ficou fiado — agora com os itens de cada compra.
    -- 'origem' sai da observação do presencial ("Presencial · Mesa 2 · Garçom: …"):
    -- só a parte "Mesa 2"/"Comanda 12"; o resto (garçom, valor) não é da conta do cliente.
    'fiados', (SELECT COALESCE(json_agg(json_build_object(
                        'data',   v.created_at,
                        'valor',  v.total,
                        'origem', substring(COALESCE(v.observacoes, '') from '(Mesa [0-9]+|Comanda [0-9]+)'),
                        'itens',  (SELECT COALESCE(json_agg(json_build_object(
                                              'nome', COALESCE(pr.nome, 'item'),
                                              'quantidade', vi.quantidade,
                                              'valor', COALESCE(vi.subtotal, vi.preco_unitario * vi.quantidade)
                                            ) ORDER BY pr.nome), '[]'::json)
                                     FROM venda_itens vi
                                     LEFT JOIN produtos pr ON pr.id = vi.produto_id
                                    WHERE vi.venda_id = v.id)
                      ) ORDER BY v.created_at DESC), '[]'::json)
                 FROM vendas v
                WHERE v.cliente_id = v_cli.id AND v.forma_pagamento <> 'a_vista'
                  AND v.status <> 'cancelado'),
    -- O que ele já pagou da dívida (só recebimento de fiado; pagamento de mesa
    -- fica de fora, senão pareceria que ele quitou o que na verdade só consumiu)
    'pagamentos', (SELECT COALESCE(json_agg(json_build_object(
                            'data', p.created_at, 'valor', p.valor,
                            'forma', p.forma_pagamento) ORDER BY p.created_at DESC), '[]'::json)
                     FROM pagamentos p
                    WHERE p.cliente_id = v_cli.id
                      AND p.venda_id IS NULL
                      AND COALESCE(p.observacao,'') NOT LIKE 'Presencial ·%'),
    -- Histórico: toda compra dele, pagando como for. As 30 últimas — o cliente
    -- quer conferir a fatura do mês, não a vida inteira. 'forma' vem da comanda
    -- quando existe, porque a venda do presencial grava 'a_vista' e o cliente
    -- lembra é do cartão que passou.
    'historico', (SELECT COALESCE(json_agg(h), '[]'::json) FROM (
                    SELECT json_build_object(
                      'data',   v.created_at,
                      'valor',  v.total,
                      'forma',  COALESCE(co.forma_pagamento, v.forma_pagamento),
                      'origem', substring(COALESCE(v.observacoes, '') from '(Mesa [0-9]+|Comanda [0-9]+)'),
                      'itens',  (SELECT COALESCE(json_agg(json_build_object(
                                            'nome', COALESCE(pr.nome, 'item'),
                                            'quantidade', vi.quantidade,
                                            'valor', COALESCE(vi.subtotal, vi.preco_unitario * vi.quantidade)
                                          ) ORDER BY vi.id), '[]'::json)
                                   FROM venda_itens vi
                                   LEFT JOIN produtos pr ON pr.id = vi.produto_id
                                  WHERE vi.venda_id = v.id)
                    ) AS h
                      FROM vendas v
                      LEFT JOIN comandas co ON co.venda_id = v.id
                     WHERE v.cliente_id = v_cli.id AND v.status <> 'cancelado'
                     ORDER BY v.created_at DESC
                     LIMIT 30) t)
  );
END;
$function$;
