-- 0133_trocar_forma_pagamento.sql
-- Permite CORRIGIR a forma de pagamento de uma conta de mesa já fechada (histórico).
--
-- Base: liga cada `pagamentos` à sua `venda` (coluna venda_id) pra poder achar/trocar
-- de forma confiável. Antes o único vínculo era o horário exato do fechamento.
--   - alterar_forma_pagamento_comanda(): troca a forma na comanda + na venda + refaz
--     o registro em pagamentos. fiado = não recebeu (apaga o pagamento e vira dívida),
--     e por isso exige um cliente de verdade ligado à conta.

-- 1) pagamentos.venda_id
ALTER TABLE public.pagamentos ADD COLUMN IF NOT EXISTS venda_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pagamentos_venda_id_fkey') THEN
    ALTER TABLE public.pagamentos
      ADD CONSTRAINT pagamentos_venda_id_fkey
      FOREIGN KEY (venda_id) REFERENCES public.vendas(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill: casa o pagamento presencial com a venda pela hora EXATA do fechamento
-- (tudo foi inserido na mesma transação, então created_at = comandas.fechada_at).
UPDATE public.pagamentos p
   SET venda_id = c.venda_id
  FROM public.comandas c
 WHERE c.venda_id IS NOT NULL
   AND p.venda_id IS NULL
   AND p.created_at = c.fechada_at;

-- 2) Fechamento agora grava venda_id no pagamento (pros próximos)
CREATE OR REPLACE FUNCTION public.fechar_conta_presencial(p_comanda_id uuid, p_pagamentos jsonb, p_aplicar_taxa boolean DEFAULT true, p_cliente_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp      uuid := current_empresa_id();
  v_com      comandas%ROWTYPE;
  v_taxa_pct numeric;
  v_subtotal numeric := 0;
  v_taxa     numeric := 0;
  v_total    numeric := 0;
  v_cliente  uuid;
  v_venda    uuid;
  v_item     comanda_itens%ROWTYPE;
  v_garcom   text;
  v_obs      text;
  v_pag      jsonb;
  v_soma     numeric := 0;
  v_fiado    numeric := 0;
  v_n        integer;
BEGIN
  SELECT * INTO v_com FROM comandas
  WHERE id = p_comanda_id AND empresa_id = v_emp AND status IN ('aberta','aguardando_conferencia');
  IF v_com.id IS NULL THEN RAISE EXCEPTION 'Comanda não encontrada ou já fechada.'; END IF;

  IF p_pagamentos IS NULL OR jsonb_array_length(p_pagamentos) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos uma forma de pagamento.';
  END IF;

  SELECT COALESCE(taxa_servico_pct, 10) INTO v_taxa_pct FROM empresas WHERE id = v_emp;

  SELECT COALESCE(SUM(preco_unitario * quantidade), 0) INTO v_subtotal
  FROM comanda_itens WHERE comanda_id = p_comanda_id;
  IF v_subtotal <= 0 THEN RAISE EXCEPTION 'Comanda sem itens.'; END IF;

  v_taxa  := CASE WHEN p_aplicar_taxa THEN ROUND(v_subtotal * v_taxa_pct / 100.0, 2) ELSE 0 END;
  v_total := v_subtotal + v_taxa;

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_soma
  FROM jsonb_array_elements(p_pagamentos) x;
  IF ABS(v_soma - v_total) > 0.05 THEN
    RAISE EXCEPTION 'A soma dos pagamentos (R$ %) não confere com o total (R$ %).', v_soma, v_total;
  END IF;

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_fiado
  FROM jsonb_array_elements(p_pagamentos) x
  WHERE x->>'forma' = 'fiado';

  IF v_fiado > 0 AND p_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Para fechar no fiado é preciso escolher o cliente.';
  END IF;

  SELECT nome INTO v_garcom FROM profiles WHERE id = v_com.garcom_id;
  v_obs := 'Presencial · Mesa ' || COALESCE(v_com.numero_mesa::text, '-')
           || CASE WHEN v_garcom IS NOT NULL THEN ' · Garçom: ' || v_garcom ELSE '' END;

  IF COALESCE(p_cliente_id, v_com.cliente_id) IS NOT NULL THEN
    SELECT id INTO v_cliente FROM clientes WHERE id = COALESCE(p_cliente_id, v_com.cliente_id) AND empresa_id = v_emp;
    IF v_cliente IS NULL THEN RAISE EXCEPTION 'Cliente não encontrado nesta empresa.'; END IF;
  ELSE
    SELECT id INTO v_cliente FROM clientes
    WHERE empresa_id = v_emp AND nome = 'Consumidor (Mesa)' LIMIT 1;
    IF v_cliente IS NULL THEN
      INSERT INTO clientes (empresa_id, nome) VALUES (v_emp, 'Consumidor (Mesa)')
      RETURNING id INTO v_cliente;
    END IF;
  END IF;

  INSERT INTO vendas (cliente_id, forma_pagamento, status, total, observacoes)
  VALUES (v_cliente,
          CASE WHEN v_fiado > 0 THEN 'fiado' ELSE 'a_vista' END,
          'entregue', v_total,
          v_obs || CASE WHEN v_fiado > 0 THEN ' · Fiado: R$ ' || TO_CHAR(v_fiado, 'FM999999990.00') ELSE '' END)
  RETURNING id INTO v_venda;

  FOR v_item IN
    SELECT * FROM comanda_itens WHERE comanda_id = p_comanda_id AND produto_id IS NOT NULL
  LOOP
    INSERT INTO venda_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
    VALUES (v_venda, v_item.produto_id::uuid, v_item.quantidade, v_item.preco_unitario,
            v_item.preco_unitario * v_item.quantidade);
    IF EXISTS (SELECT 1 FROM produtos WHERE id = v_item.produto_id::uuid AND COALESCE(controla_estoque, true) = true) THEN
      INSERT INTO estoque_movimentos (produto_id, tipo, quantidade, motivo, observacao)
      VALUES (v_item.produto_id::uuid, 'saida', v_item.quantidade, 'venda', v_obs);
    END IF;
  END LOOP;

  FOR v_pag IN SELECT * FROM jsonb_array_elements(p_pagamentos)
  LOOP
    IF (v_pag->>'valor')::numeric > 0 AND (v_pag->>'forma') <> 'fiado' THEN
      INSERT INTO pagamentos (venda_id, cliente_id, forma_pagamento, valor, observacao)
      VALUES (v_venda, v_cliente,
              CASE WHEN (v_pag->>'forma') IN ('dinheiro','pix','cartao','transferencia')
                   THEN v_pag->>'forma' ELSE 'dinheiro' END,
              (v_pag->>'valor')::numeric, v_obs);
    END IF;
  END LOOP;

  v_n := jsonb_array_length(p_pagamentos);
  UPDATE comandas SET status = 'fechada', subtotal = v_subtotal, taxa_servico = v_taxa,
         total = v_total,
         forma_pagamento = CASE WHEN v_n > 1 THEN 'dividido' ELSE p_pagamentos->0->>'forma' END,
         fechada_at = now(),
         venda_id = v_venda,
         cliente_id = COALESCE(p_cliente_id, v_com.cliente_id)
  WHERE id = p_comanda_id;

  IF v_com.mesa_id IS NOT NULL THEN
    UPDATE mesas SET status = 'livre' WHERE id = v_com.mesa_id;
  END IF;

  RETURN v_venda;
END;
$function$;

-- 3) Corrigir a forma de pagamento de uma conta JÁ FECHADA.
CREATE OR REPLACE FUNCTION public.alterar_forma_pagamento_comanda(p_comanda_id uuid, p_forma text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp     uuid := current_empresa_id();
  v_com     comandas%ROWTYPE;
  v_forma   text := lower(btrim(p_forma));
  v_cliente uuid;
  v_obs     text;
BEGIN
  SELECT * INTO v_com FROM comandas WHERE id = p_comanda_id AND empresa_id = v_emp AND status = 'fechada';
  IF v_com.id IS NULL THEN RAISE EXCEPTION 'Conta não encontrada ou não está fechada.'; END IF;

  IF v_forma NOT IN ('dinheiro','pix','cartao','fiado') THEN
    RAISE EXCEPTION 'Forma inválida. Use dinheiro, pix, cartão ou fiado.';
  END IF;

  -- Conta antiga sem venda vinculada: só corrige o rótulo na comanda.
  IF v_com.venda_id IS NULL THEN
    UPDATE comandas SET forma_pagamento = v_forma WHERE id = p_comanda_id;
    RETURN;
  END IF;

  SELECT cliente_id INTO v_cliente FROM vendas WHERE id = v_com.venda_id;
  v_obs := 'Presencial · Mesa ' || COALESCE(v_com.numero_mesa::text, '-') || ' · forma corrigida';

  IF v_forma = 'fiado' THEN
    -- Fiado = a loja NÃO recebeu; vira dívida do cliente. Precisa de um cliente real.
    IF v_cliente IS NULL OR EXISTS (SELECT 1 FROM clientes WHERE id = v_cliente AND nome = 'Consumidor (Mesa)') THEN
      RAISE EXCEPTION 'Pra deixar no fiado, ligue um cliente de verdade à conta primeiro.';
    END IF;
    DELETE FROM pagamentos WHERE venda_id = v_com.venda_id;
    UPDATE vendas SET forma_pagamento = 'fiado' WHERE id = v_com.venda_id;
  ELSE
    -- Recebido à vista: um pagamento único do total, na forma escolhida.
    -- created_at = fechada_at pra o dinheiro continuar contando no dia certo.
    DELETE FROM pagamentos WHERE venda_id = v_com.venda_id;
    INSERT INTO pagamentos (venda_id, cliente_id, forma_pagamento, valor, observacao, created_at)
    VALUES (v_com.venda_id, v_cliente, v_forma, v_com.total, v_obs, COALESCE(v_com.fechada_at, now()));
    UPDATE vendas SET forma_pagamento = 'a_vista' WHERE id = v_com.venda_id;
  END IF;

  UPDATE comandas SET forma_pagamento = v_forma WHERE id = p_comanda_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.alterar_forma_pagamento_comanda(uuid, text) TO authenticated;
