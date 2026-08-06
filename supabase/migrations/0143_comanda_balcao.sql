-- 0143_comanda_balcao.sql
-- COMANDA DE BALCÃO: comanda numerada que não pertence a mesa nenhuma.
--
-- Por quê: tem loja (Estação do Sabor) em que o cliente pede no balcão, em pé, e
-- só depois senta (ou nem senta). Hoje o jeito de atender era cadastrar mesas
-- falsas e usar cada uma como "comanda" — o que trava no número de mesas
-- cadastradas, deixa QR de mesa apontando pra conta de outro cliente e enche a
-- tela de mesa vazia.
--
-- Como funciona: a comanda já é uma linha própria em `comandas` e `mesa_id` já
-- aceita NULL. Então a comanda de balcão é só uma comanda SEM mesa, com número
-- próprio (01, 02, 03...) que ZERA todO dia e um nome livre pra identificar
-- ("Maria", "moço da moto"). Nada de mesa temporária: quando a conta fecha, a
-- comanda some da tela sozinha e não sobra lixo.
--
-- Convive com as mesas de verdade: a loja pode ter as duas coisas ao mesmo tempo.
-- Desligado por padrão — nenhuma loja muda de comportamento sem ligar o botão.

-- 1) Interruptor por loja
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS comanda_balcao_ativa boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.empresas.comanda_balcao_ativa IS
  'true = o Salao mostra o botao "+ Nova comanda" (comanda de balcao, sem mesa).';

-- 2) Colunas da comanda de balcão
--    tipo        : 'mesa' (o de sempre) | 'balcao' (a nova)
--    nome_cliente: nome livre, sem precisar cadastrar cliente (cliente_id continua
--                  existindo pra quem quer ligar um cliente de verdade — fiado etc.)
--    dia         : dia da numeração (fuso de Brasília). É o que faz o número zerar.
ALTER TABLE public.comandas ADD COLUMN IF NOT EXISTS tipo         text NOT NULL DEFAULT 'mesa';
ALTER TABLE public.comandas ADD COLUMN IF NOT EXISTS nome_cliente text;
ALTER TABLE public.comandas ADD COLUMN IF NOT EXISTS dia          date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comandas_tipo_check') THEN
    ALTER TABLE public.comandas
      ADD CONSTRAINT comandas_tipo_check CHECK (tipo IN ('mesa','balcao'));
  END IF;
END $$;

-- Dois atendentes abrindo comanda ao mesmo tempo não podem receber o mesmo número.
-- O índice é a garantia de verdade (o lock abaixo só evita o erro aparecer).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_comanda_balcao_numero
  ON public.comandas (empresa_id, dia, numero_mesa)
  WHERE tipo = 'balcao';

CREATE INDEX IF NOT EXISTS idx_comandas_balcao_abertas
  ON public.comandas (empresa_id, status)
  WHERE tipo = 'balcao';

-- 3) Rótulo da comanda — usado em toda observação que vai pro histórico/relatório.
--    "Mesa 4" pro de sempre, "Comanda 07 · Maria" pra de balcão. Sem isso a venda
--    da comanda 3 sairia escrita "Mesa 3" e se misturaria com a mesa 3 de verdade.
CREATE OR REPLACE FUNCTION public.rotulo_comanda(p_com public.comandas)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_com.tipo = 'balcao'
      THEN 'Comanda ' || LPAD(COALESCE(p_com.numero_mesa::text, '-'), 2, '0')
           || COALESCE(' · ' || NULLIF(BTRIM(p_com.nome_cliente), ''), '')
    ELSE 'Mesa ' || COALESCE(p_com.numero_mesa::text, '-')
  END;
$function$;

-- 4) Abrir comanda de balcão: pega o próximo número livre do dia e já devolve a
--    comanda pronta. O número é calculado aqui dentro (não no navegador) porque
--    dois celulares clicando junto pegariam o mesmo número.
CREATE OR REPLACE FUNCTION public.abrir_comanda_balcao(p_nome text DEFAULT NULL, p_cliente_id uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp  uuid := current_empresa_id();
  v_dia  date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_num  integer;
  v_id   uuid;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'Empresa não identificada.'; END IF;

  IF p_cliente_id IS NOT NULL THEN
    PERFORM 1 FROM clientes WHERE id = p_cliente_id AND empresa_id = v_emp;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado nesta empresa.'; END IF;
  END IF;

  -- Serializa por loja+dia: o segundo a chegar espera o primeiro gravar o número.
  PERFORM pg_advisory_xact_lock(hashtext(v_emp::text || v_dia::text));

  SELECT COALESCE(MAX(numero_mesa), 0) + 1 INTO v_num
  FROM comandas
  WHERE empresa_id = v_emp AND tipo = 'balcao' AND dia = v_dia;

  INSERT INTO comandas (empresa_id, mesa_id, numero_mesa, tipo, nome_cliente, dia, cliente_id, garcom_id)
  VALUES (v_emp, NULL, v_num, 'balcao', NULLIF(BTRIM(p_nome), ''), v_dia, p_cliente_id, auth.uid())
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.abrir_comanda_balcao(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.abrir_comanda_balcao(text, uuid) TO authenticated;

-- 5) Renomear a comanda depois de aberta (o atendente pergunta o nome no meio).
CREATE OR REPLACE FUNCTION public.renomear_comanda_balcao(p_comanda_id uuid, p_nome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp uuid := current_empresa_id();
BEGIN
  UPDATE comandas SET nome_cliente = NULLIF(BTRIM(p_nome), '')
  WHERE id = p_comanda_id AND empresa_id = v_emp AND tipo = 'balcao';
  IF NOT FOUND THEN RAISE EXCEPTION 'Comanda não encontrada.'; END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.renomear_comanda_balcao(uuid, text) TO authenticated;

-- 6) Fechamento: mesma função de sempre, mudando SÓ o rótulo da observação (agora
--    sai "Comanda 07 · Maria" na comanda de balcão). O resto é idêntico ao 0141.
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
  v_obs := 'Presencial · ' || rotulo_comanda(v_com)
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

-- 7) Trocar a forma depois: mesmo ajuste de rótulo (o resto é igual ao 0141).
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
  v_obs := 'Presencial · ' || rotulo_comanda(v_com) || ' · forma corrigida';

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
