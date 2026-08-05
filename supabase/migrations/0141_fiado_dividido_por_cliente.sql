-- 0141_fiado_dividido_por_cliente.sql
-- "Dividir conta" agora aceita fiado com um DONO POR LINHA.
--
-- Antes: a comanda inteira virava UMA venda com UM cliente_id. Duas pessoas na
-- mesma mesa, cada uma fiando a sua parte, era impossível — as duas dívidas caíam
-- no saldo de quem fosse escolhido. O contorno (abrir duas mesas e "inventar
-- produto" pra rachar a bebida) ainda deixava o estoque errado, porque item
-- avulso não tem produto_id e não dá baixa.
--
-- Agora p_pagamentos aceita cliente_id por linha:
--   [{"forma":"fiado","valor":25,"cliente_id":"<maria>"},
--    {"forma":"fiado","valor":25,"cliente_id":"<joao>"},
--    {"forma":"pix","valor":10}]
-- Linha SEM cliente_id continua caindo no p_cliente_id: telas antigas e contas que
-- o garçom deixou pendentes (fechamento_pendente) seguem fechando igual.
--
-- Como a dívida mora em vendas.cliente_id + vendas.total (view clientes_saldo_fiado),
-- um fechamento com 2 devedores gera:
--   • 1 venda 'a_vista' com a parte recebida  ← leva os itens e a baixa de estoque
--   • 1 venda 'fiado' POR cliente devedor, com a parte dele
-- A soma das vendas continua igual ao total da conta.
--
-- Efeito colateral bom: o fiado PARCIAL não batia no Caixa. A venda saía com o
-- total CHEIO como 'fiado' e a parte recebida entrava também em `pagamentos`, então
-- o faturamento do caixa (recebimentos + vendas_fiado) contava o pedaço pago duas
-- vezes. Separando as vendas, cada real aparece uma vez só.

-- 1) Liga a venda à comanda que a gerou. Sem isso não dá pra achar as vendas
--    "irmãs" de um fechamento dividido (comandas.venda_id guarda só uma).
ALTER TABLE public.vendas ADD COLUMN IF NOT EXISTS comanda_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendas_comanda_id_fkey') THEN
    ALTER TABLE public.vendas
      ADD CONSTRAINT vendas_comanda_id_fkey
      FOREIGN KEY (comanda_id) REFERENCES public.comandas(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_vendas_comanda ON public.vendas(comanda_id);

-- Backfill do que já existe (1 venda por comanda) — mantém o histórico consultável.
UPDATE public.vendas v
   SET comanda_id = c.id
  FROM public.comandas c
 WHERE c.venda_id = v.id
   AND v.comanda_id IS NULL;

-- 2) Fechamento com fiado dividido
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
  v_cliente  uuid;      -- dono da parte RECEBIDA (cliente da mesa ou o genérico)
  v_dono     uuid;      -- fallback pra linha de fiado que vier sem cliente_id
  v_venda    uuid;      -- venda principal: leva os itens/estoque e é o retorno
  v_vfiado   uuid;
  v_item     comanda_itens%ROWTYPE;
  v_garcom   text;
  v_obs      text;
  v_pag      jsonb;
  v_soma     numeric := 0;
  v_fiado    numeric := 0;
  v_pago     numeric := 0;
  v_n        integer;
  v_dev      record;
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

  -- Parte recebida = total − fiado (e não a soma das linhas): garante que as vendas
  -- geradas somem EXATAMENTE o total, mesmo com os 5 centavos de tolerância acima.
  v_pago := ROUND(v_total - v_fiado, 2);
  IF v_pago < 0 THEN v_pago := 0; END IF;

  v_dono := COALESCE(p_cliente_id, v_com.cliente_id);

  -- Toda linha de fiado precisa de dono — o da própria linha ou o da conta. Sem isso
  -- a dívida cairia no "Consumidor (Mesa)" e ninguém saberia de quem cobrar.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_pagamentos) x
    WHERE x->>'forma' = 'fiado'
      AND (x->>'valor')::numeric > 0
      AND COALESCE(NULLIF(x->>'cliente_id','')::uuid, v_dono) IS NULL
  ) THEN
    RAISE EXCEPTION 'Para fechar no fiado é preciso escolher o cliente.';
  END IF;

  SELECT nome INTO v_garcom FROM profiles WHERE id = v_com.garcom_id;
  v_obs := 'Presencial · Mesa ' || COALESCE(v_com.numero_mesa::text, '-')
           || CASE WHEN v_garcom IS NOT NULL THEN ' · Garçom: ' || v_garcom ELSE '' END;

  IF v_dono IS NOT NULL THEN
    -- confere que o cliente é desta empresa (a função é SECURITY DEFINER)
    SELECT id INTO v_cliente FROM clientes WHERE id = v_dono AND empresa_id = v_emp;
    IF v_cliente IS NULL THEN RAISE EXCEPTION 'Cliente não encontrado nesta empresa.'; END IF;
  ELSE
    SELECT id INTO v_cliente FROM clientes
    WHERE empresa_id = v_emp AND nome = 'Consumidor (Mesa)' LIMIT 1;
    IF v_cliente IS NULL THEN
      INSERT INTO clientes (empresa_id, nome) VALUES (v_emp, 'Consumidor (Mesa)')
      RETURNING id INTO v_cliente;
    END IF;
  END IF;

  -- Venda da parte RECEBIDA. Vem primeiro de propósito: é ela que vira a venda
  -- principal (leva os itens e recebe as linhas de `pagamentos`).
  IF v_pago > 0.005 THEN
    INSERT INTO vendas (cliente_id, forma_pagamento, status, total, observacoes, comanda_id)
    VALUES (v_cliente, 'a_vista', 'entregue', v_pago,
            v_obs || CASE WHEN v_fiado > 0 THEN ' · parte recebida' ELSE '' END,
            p_comanda_id)
    RETURNING id INTO v_venda;
  END IF;

  -- Uma venda 'fiado' por devedor (linhas do mesmo cliente somam numa dívida só).
  FOR v_dev IN
    SELECT COALESCE(NULLIF(x->>'cliente_id','')::uuid, v_dono) AS cliente_id,
           ROUND(SUM((x->>'valor')::numeric), 2)               AS valor
    FROM jsonb_array_elements(p_pagamentos) x
    WHERE x->>'forma' = 'fiado' AND (x->>'valor')::numeric > 0
    GROUP BY 1
  LOOP
    PERFORM 1 FROM clientes WHERE id = v_dev.cliente_id AND empresa_id = v_emp;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cliente do fiado não encontrado nesta empresa.'; END IF;

    INSERT INTO vendas (cliente_id, forma_pagamento, status, total, observacoes, comanda_id)
    VALUES (v_dev.cliente_id, 'fiado', 'entregue', v_dev.valor,
            v_obs || ' · Fiado: R$ ' || TO_CHAR(v_dev.valor, 'FM999999990.00'),
            p_comanda_id)
    RETURNING id INTO v_vfiado;

    -- Conta 100% fiada: não existe venda à vista, então os itens vão na primeira
    -- venda de fiado (o total dela é só a parte daquele cliente — quem lê produto
    -- vendido usa venda_itens, e o faturamento usa a soma das vendas).
    IF v_venda IS NULL THEN v_venda := v_vfiado; END IF;
  END LOOP;

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
    -- 'fiado' NÃO vira linha de pagamento: é a ausência dela que faz o saldo devedor
    -- aparecer em clientes_saldo_fiado. Quando o cliente pagar, o recebimento é
    -- lançado no Portal Fiado e abate o saldo.
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

REVOKE ALL ON FUNCTION public.fechar_conta_presencial(uuid, jsonb, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fechar_conta_presencial(uuid, jsonb, boolean, uuid) TO authenticated, service_role;

-- 3) Trocar a forma depois NÃO pode desmontar um fechamento dividido: a função mexe
--    numa venda só (comandas.venda_id) e deixaria as dívidas dos outros clientes
--    penduradas. Nesse caso ela recusa e manda ajustar pelo Portal Fiado.
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
  v_qtd     integer;
BEGIN
  SELECT * INTO v_com FROM comandas WHERE id = p_comanda_id AND empresa_id = v_emp AND status = 'fechada';
  IF v_com.id IS NULL THEN RAISE EXCEPTION 'Conta não encontrada ou não está fechada.'; END IF;

  IF v_forma NOT IN ('dinheiro','pix','cartao','fiado') THEN
    RAISE EXCEPTION 'Forma inválida. Use dinheiro, pix, cartão ou fiado.';
  END IF;

  SELECT COUNT(*) INTO v_qtd FROM vendas WHERE comanda_id = p_comanda_id;
  IF v_qtd > 1 THEN
    RAISE EXCEPTION 'Esta conta foi dividida entre mais de um cliente. Ajuste os valores pelo Portal Fiado.';
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
    UPDATE vendas SET forma_pagamento = 'fiado', total = v_com.total WHERE id = v_com.venda_id;
  ELSE
    -- Recebido à vista: um pagamento único do total, na forma escolhida.
    -- created_at = fechada_at pra o dinheiro continuar contando no dia certo.
    DELETE FROM pagamentos WHERE venda_id = v_com.venda_id;
    INSERT INTO pagamentos (venda_id, cliente_id, forma_pagamento, valor, observacao, created_at)
    VALUES (v_com.venda_id, v_cliente, v_forma, v_com.total, v_obs, COALESCE(v_com.fechada_at, now()));
    UPDATE vendas SET forma_pagamento = 'a_vista', total = v_com.total WHERE id = v_com.venda_id;
  END IF;

  UPDATE comandas SET forma_pagamento = v_forma WHERE id = p_comanda_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.alterar_forma_pagamento_comanda(uuid, text) TO authenticated;
