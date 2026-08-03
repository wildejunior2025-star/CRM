-- 0131_comanda_cliente.sql
-- Permite ligar um CLIENTE a uma comanda (mesa/balcão) — tanto ao lançar o pedido
-- quanto depois, no histórico de contas fechadas.
--
--  - comandas.cliente_id: o cliente daquela mesa (opcional).
--  - comandas.venda_id  : a venda gerada no fechamento (pra propagar o cliente pro
--                         registro de venda quando ele é ligado só depois).
--  - vincular_cliente_comanda(): seta o cliente na comanda (e na venda, se já fechada).
--  - fechar_conta_presencial(): agora grava venda_id e cliente_id na comanda.

-- 1) Colunas novas (idempotente)
ALTER TABLE public.comandas ADD COLUMN IF NOT EXISTS cliente_id uuid;
ALTER TABLE public.comandas ADD COLUMN IF NOT EXISTS venda_id   uuid;

-- FKs com ON DELETE SET NULL (se o cliente/venda sumir, a comanda não quebra)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comandas_cliente_id_fkey') THEN
    ALTER TABLE public.comandas
      ADD CONSTRAINT comandas_cliente_id_fkey
      FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comandas_venda_id_fkey') THEN
    ALTER TABLE public.comandas
      ADD CONSTRAINT comandas_venda_id_fkey
      FOREIGN KEY (venda_id) REFERENCES public.vendas(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2) Ligar/desligar o cliente de uma comanda. Propaga pra venda gerada (se houver).
CREATE OR REPLACE FUNCTION public.vincular_cliente_comanda(p_comanda_id uuid, p_cliente_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp uuid := current_empresa_id();
  v_com comandas%ROWTYPE;
BEGIN
  SELECT * INTO v_com FROM comandas WHERE id = p_comanda_id AND empresa_id = v_emp;
  IF v_com.id IS NULL THEN RAISE EXCEPTION 'Comanda não encontrada.'; END IF;

  IF p_cliente_id IS NOT NULL THEN
    PERFORM 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = v_emp;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado nesta empresa.'; END IF;
  END IF;

  UPDATE comandas SET cliente_id = p_cliente_id WHERE id = p_comanda_id;

  -- Já fechada? corrige também o cliente da venda (era "Consumidor (Mesa)").
  IF v_com.venda_id IS NOT NULL AND p_cliente_id IS NOT NULL THEN
    UPDATE vendas SET cliente_id = p_cliente_id WHERE id = v_com.venda_id AND empresa_id = v_emp;
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.vincular_cliente_comanda(uuid, uuid) TO authenticated;

-- 3) Fechamento: grava a venda e o cliente na própria comanda.
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

  -- Cliente: o do argumento; senão o que já estava na comanda; senão o genérico.
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
      INSERT INTO pagamentos (cliente_id, forma_pagamento, valor, observacao)
      VALUES (v_cliente,
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
         -- guarda o cliente REAL escolhido (NULL vira genérico, então não sobrescreve
         -- com "Consumidor (Mesa)"; mantém o que já estava ligado na comanda)
         cliente_id = COALESCE(p_cliente_id, v_com.cliente_id)
  WHERE id = p_comanda_id;

  IF v_com.mesa_id IS NOT NULL THEN
    UPDATE mesas SET status = 'livre' WHERE id = v_com.mesa_id;
  END IF;

  RETURN v_venda;
END;
$function$;
