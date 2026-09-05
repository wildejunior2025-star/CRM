-- 0243_pix_da_mesa_fecha_sem_sessao.sql
-- O PIX da mesa caía e a conta NÃO fechava.
--
-- Saidera, 05/09 22:50. O cliente pagou R$ 4,00 no QR, o Mercado Pago avisou, o
-- webhook chamou a função — e ela morreu com:
--   null value in column "empresa_id" of relation "vendas"
-- A transação inteira voltou atrás: a cobrança ficou "pendente", a mesa ficou
-- aberta e o QR continuou na tela. Dinheiro na conta da loja e o sistema cego.
--
-- Causa: `vendas`, `venda_itens`, `pagamentos` e `estoque_movimentos` têm
-- empresa_id NOT NULL DEFAULT current_empresa_id(). A função nunca passou o
-- valor — ela dependia do DEFAULT. Pelo salão isso funciona, porque existe uma
-- sessão logada. Pelo WEBHOOK não existe sessão nenhuma: current_empresa_id()
-- devolve NULL e o INSERT quebra.
--
-- Na prática o PIX da mesa nunca fechou a conta sozinho: o "conferir" da tela
-- também chama a função pelo service_role e batia no mesmo muro.
--
-- A função já recebe p_empresa_id e guarda em v_emp — ela só não usava nos
-- INSERTs. A cirurgia abaixo passa v_emp explicitamente nos cinco, e confere
-- que os cinco foram corrigidos antes de publicar: função de dinheiro pela
-- metade é pior que função quebrada.
DO $cirurgia$
DECLARE
  v_def  text;
  v_novo text;
  v_trocas int := 0;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fechar_conta_presencial_interno';
  IF v_def IS NULL THEN RAISE EXCEPTION 'função não encontrada'; END IF;
  v_novo := v_def;

  v_novo := replace(v_novo,
    'INSERT INTO vendas (cliente_id, forma_pagamento, status, total, observacoes, comanda_id)' || chr(10) || '    VALUES (v_cliente,',
    'INSERT INTO vendas (empresa_id, cliente_id, forma_pagamento, status, total, observacoes, comanda_id)' || chr(10) || '    VALUES (v_emp, v_cliente,');
  v_novo := replace(v_novo,
    'INSERT INTO vendas (cliente_id, forma_pagamento, status, total, observacoes, comanda_id)' || chr(10) || '    VALUES (v_dev.cliente_id,',
    'INSERT INTO vendas (empresa_id, cliente_id, forma_pagamento, status, total, observacoes, comanda_id)' || chr(10) || '    VALUES (v_emp, v_dev.cliente_id,');
  v_novo := replace(v_novo,
    'INSERT INTO venda_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)' || chr(10) || '    VALUES (v_venda,',
    'INSERT INTO venda_itens (empresa_id, venda_id, produto_id, quantidade, preco_unitario, subtotal)' || chr(10) || '    VALUES (v_emp, v_venda,');
  v_novo := replace(v_novo,
    'INSERT INTO estoque_movimentos (produto_id, tipo, quantidade, motivo, observacao)' || chr(10) || '      VALUES (v_item.produto_id::uuid,',
    'INSERT INTO estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao)' || chr(10) || '      VALUES (v_emp, v_item.produto_id::uuid,');
  v_novo := replace(v_novo,
    'INSERT INTO pagamentos (venda_id, cliente_id, forma_pagamento, valor, observacao)' || chr(10) || '      VALUES (v_venda, v_cliente,',
    'INSERT INTO pagamentos (empresa_id, venda_id, cliente_id, forma_pagamento, valor, observacao)' || chr(10) || '      VALUES (v_emp, v_venda, v_cliente,');

  SELECT count(*) INTO v_trocas FROM (
    SELECT regexp_matches(v_novo, 'INSERT INTO (vendas|venda_itens|pagamentos|estoque_movimentos) \(empresa_id,', 'g')
  ) t;
  IF v_trocas <> 5 THEN
    RAISE EXCEPTION 'esperava 5 INSERTs corrigidos, achei %', v_trocas;
  END IF;

  EXECUTE v_novo;
END
$cirurgia$;

COMMENT ON FUNCTION public.fechar_conta_presencial_interno(uuid, jsonb, boolean, uuid, uuid) IS
  'Fecha a conta da mesa. Passa empresa_id EXPLÍCITO em todos os INSERTs: o DEFAULT current_empresa_id() é nulo quando quem chama é o webhook do Mercado Pago, e aí o PIX pago não fechava a conta (mig 0243).';

NOTIFY pgrst, 'reload schema';
