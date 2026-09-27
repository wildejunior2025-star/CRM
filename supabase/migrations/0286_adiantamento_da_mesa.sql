-- 0286_adiantamento_da_mesa.sql
-- "Vou pagar 50 e o resto fica com eles."
--
-- A mesa já sabia separar a conta por ITEM (mig 0205/0229): o amigo marca as
-- cervejas dele e leva a conta separada. Mas muita gente não escolhe produto —
-- escolhe VALOR: põe R$ 50 e vai embora. Não havia como receber isso: o
-- fechamento exige que os pagamentos somem o total, e a mesa não tinha onde
-- guardar um pagamento adiantado.
--
-- Aqui cada valor recebido antes do fechamento vira uma linha desta tabela.
-- A mesa continua com TODOS os itens (quem paga por valor não quer escolher
-- item) e passa a mostrar "Pago R$ 50 · Falta R$ 78".
--
-- O dinheiro entra no caixa no FECHAMENTO, não na hora (decisão do Wilde,
-- 26/09): o fechamento junta os adiantamentos às formas de pagamento do resto,
-- a venda sai cheia e o caixa do dia bate sem ninguém lançar nada à mão.
CREATE TABLE IF NOT EXISTS public.comanda_adiantamentos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  comanda_id  uuid NOT NULL REFERENCES public.comandas(id) ON DELETE CASCADE,
  valor       numeric(10,2) NOT NULL CHECK (valor > 0),
  forma       text NOT NULL DEFAULT 'dinheiro'
              CHECK (forma IN ('dinheiro','pix','credito','debito','cartao','transferencia')),
  quem        text,          -- nome de quem pagou, quando a mesa quis anotar
  criado_por  uuid REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.comanda_adiantamentos IS
  'Valores pagos ANTES do fechamento da comanda ("vou pagar 50"). Entram como pagamento na hora de fechar (mig 0286).';

CREATE INDEX IF NOT EXISTS comanda_adiantamentos_comanda ON public.comanda_adiantamentos (comanda_id);

ALTER TABLE public.comanda_adiantamentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comanda_adiantamentos_own ON public.comanda_adiantamentos;
CREATE POLICY comanda_adiantamentos_own ON public.comanda_adiantamentos
  FOR ALL USING (empresa_id = (SELECT current_empresa_id()))
  WITH CHECK (empresa_id = (SELECT current_empresa_id()));

-- Quem já lança item na mesa pode receber um valor dela.
GRANT SELECT, INSERT, DELETE ON public.comanda_adiantamentos TO authenticated;

-- ── O fechamento passa a contar o que já foi adiantado ──────────────────────
-- Só duas mudanças na função: os adiantamentos são somados às formas de
-- pagamento logo no começo (por isso a conta de "a linha sem valor vira o
-- resto" já nasce certa), e uma lista de pagamento vazia deixa de ser erro
-- quando o adiantamento cobre a conta inteira.
CREATE OR REPLACE FUNCTION public.fechar_conta_presencial_interno(p_comanda_id uuid, p_pagamentos jsonb, p_aplicar_taxa boolean, p_cliente_id uuid, p_empresa_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp      uuid := p_empresa_id;
  v_com      comandas%ROWTYPE;
  v_taxa_pct numeric;
  v_subtotal numeric := 0;
  v_base     numeric := 0;    -- subtotal SEM os itens isentos: e sobre ele que a taxa e calculada
  v_taxa     numeric := 0;
  v_total    numeric := 0;
  v_cliente  uuid;
  v_dono     uuid;
  v_venda    uuid;
  v_vfiado   uuid;
  v_item     comanda_itens%ROWTYPE;
  v_garcom   text;
  v_obs      text;
  v_pag      jsonb;
  v_soma     numeric := 0;
  v_fiado    numeric := 0;
  v_cashback numeric := 0;    -- crédito da loja usado nesta conta
  v_saldo    numeric := 0;
  v_pago     numeric := 0;
  v_n        integer;
  v_sem      integer;
  v_dev      record;
  v_adiant   numeric := 0;    -- já pago antes de fechar (mig 0286)
BEGIN
  SELECT * INTO v_com FROM comandas
  WHERE id = p_comanda_id AND empresa_id = v_emp AND status IN ('aberta','aguardando_conferencia');
  IF v_com.id IS NULL THEN RAISE EXCEPTION 'Comanda não encontrada ou já fechada.'; END IF;

  -- O que a mesa já pagou entra como forma de pagamento, igual ao resto: é
  -- assim que a venda sai cheia e o caixa do dia bate.
  SELECT COALESCE(SUM(valor), 0) INTO v_adiant
  FROM comanda_adiantamentos WHERE comanda_id = p_comanda_id;

  IF v_adiant > 0 THEN
    SELECT COALESCE(p_pagamentos, '[]'::jsonb)
           || COALESCE(jsonb_agg(jsonb_build_object('forma', forma, 'valor', valor)), '[]'::jsonb)
      INTO p_pagamentos
      FROM comanda_adiantamentos WHERE comanda_id = p_comanda_id;
  END IF;

  IF p_pagamentos IS NULL OR jsonb_array_length(p_pagamentos) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos uma forma de pagamento.';
  END IF;

  SELECT COALESCE(taxa_servico_pct, 10) INTO v_taxa_pct FROM empresas WHERE id = v_emp;

  SELECT COALESCE(SUM(preco_unitario * quantidade), 0) INTO v_subtotal
  FROM comanda_itens WHERE comanda_id = p_comanda_id;
  IF v_subtotal <= 0 THEN RAISE EXCEPTION 'Comanda sem itens.'; END IF;

  -- Item de categoria isenta (couvert, ingresso) entra na conta mas fica FORA
  -- da base da taxa: taxa e servico de mesa, nao percentual sobre o cache do
  -- artista (mig 0192).
  SELECT COALESCE(SUM(preco_unitario * quantidade), 0) INTO v_base
  FROM comanda_itens WHERE comanda_id = p_comanda_id AND isento_taxa IS NOT TRUE;

  v_taxa  := CASE WHEN p_aplicar_taxa THEN ROUND(v_base * v_taxa_pct / 100.0, 2) ELSE 0 END;
  v_total := v_subtotal + v_taxa;

  SELECT COUNT(*) INTO v_sem
  FROM jsonb_array_elements(p_pagamentos) x
  WHERE x->>'valor' IS NULL OR BTRIM(x->>'valor') = '';

  IF v_sem > 1 THEN
    RAISE EXCEPTION 'Só uma linha do pagamento pode ficar sem valor (ela vira o resto da conta).';
  END IF;

  IF v_sem = 1 THEN
    SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_soma
    FROM jsonb_array_elements(p_pagamentos) x
    WHERE x->>'valor' IS NOT NULL AND BTRIM(x->>'valor') <> '';

    SELECT jsonb_agg(
             CASE WHEN x->>'valor' IS NULL OR BTRIM(x->>'valor') = ''
                  THEN x || jsonb_build_object('valor', ROUND(v_total - v_soma, 2))
                  ELSE x END)
    INTO p_pagamentos
    FROM jsonb_array_elements(p_pagamentos) x;
  END IF;

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_soma
  FROM jsonb_array_elements(p_pagamentos) x;
  IF ABS(v_soma - v_total) > 0.05 THEN
    RAISE EXCEPTION 'A conta mudou depois que ela foi fechada: o pagamento lançado soma R$ % e a conta agora está R$ %. Abra a mesa e feche de novo com o valor certo.',
      TO_CHAR(v_soma, 'FM999999990.00'), TO_CHAR(v_total, 'FM999999990.00');
  END IF;

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_fiado
  FROM jsonb_array_elements(p_pagamentos) x
  WHERE x->>'forma' = 'fiado';

  SELECT COALESCE(SUM((x->>'valor')::numeric), 0) INTO v_cashback
  FROM jsonb_array_elements(p_pagamentos) x
  WHERE x->>'forma' = 'cashback';

  v_dono := COALESCE(p_cliente_id, v_com.cliente_id);

  -- Travas do crédito
  IF v_cashback > 0 THEN
    -- Crédito é de alguém. Sem cliente na conta não há de quem descontar, e o
    -- valor sumiria do caixa sem dono — a loja pagaria sem saber pra quem.
    IF v_dono IS NULL THEN
      RAISE EXCEPTION 'Para usar o crédito é preciso ligar o cliente à comanda.';
    END IF;

    -- O saldo é conferido AQUI, não na tela: a tela é do garçom e pode estar
    -- desatualizada, e o mesmo cliente pode ter gasto noutra mesa no meio.
    v_saldo := fidelidade_saldo_de(v_emp, v_dono);
    IF v_cashback > v_saldo + 0.005 THEN
      RAISE EXCEPTION 'Crédito insuficiente: o cliente tem R$ % e a conta usou R$ %.',
        TO_CHAR(v_saldo, 'FM999999990.00'), TO_CHAR(v_cashback, 'FM999999990.00');
    END IF;

    -- Nunca cobre a conta inteira: a loja precisa receber alguma coisa, e conta
    -- fechada sem nenhum dinheiro confunde o caixa e o fechamento do dia.
    IF v_cashback >= v_total - 0.005 THEN
      RAISE EXCEPTION 'O crédito não pode cobrir a conta inteira.';
    END IF;
  END IF;

  -- Parte "recebida" = total − fiado. O cashback FICA aqui de propósito: é ele
  -- que mantém a venda cheia (R$ 100 e não R$ 90) e o custo visível à parte.
  v_pago := ROUND(v_total - v_fiado, 2);
  IF v_pago < 0 THEN v_pago := 0; END IF;

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

  IF v_pago > 0.005 THEN
    INSERT INTO vendas (empresa_id, cliente_id, forma_pagamento, status, total, observacoes, comanda_id)
    VALUES (v_emp, v_cliente, 'a_vista', 'entregue', v_pago,
            v_obs || CASE WHEN v_fiado > 0 THEN ' · parte recebida' ELSE '' END,
            p_comanda_id)
    RETURNING id INTO v_venda;
  END IF;

  FOR v_dev IN
    SELECT COALESCE(NULLIF(x->>'cliente_id','')::uuid, v_dono) AS cliente_id,
           ROUND(SUM((x->>'valor')::numeric), 2)               AS valor
    FROM jsonb_array_elements(p_pagamentos) x
    WHERE x->>'forma' = 'fiado' AND (x->>'valor')::numeric > 0
    GROUP BY 1
  LOOP
    PERFORM 1 FROM clientes WHERE id = v_dev.cliente_id AND empresa_id = v_emp;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cliente do fiado não encontrado nesta empresa.'; END IF;

    INSERT INTO vendas (empresa_id, cliente_id, forma_pagamento, status, total, observacoes, comanda_id)
    VALUES (v_emp, v_dev.cliente_id, 'fiado', 'entregue', v_dev.valor,
            v_obs || ' · Fiado: R$ ' || TO_CHAR(v_dev.valor, 'FM999999990.00'),
            p_comanda_id)
    RETURNING id INTO v_vfiado;

    IF v_venda IS NULL THEN v_venda := v_vfiado; END IF;
  END LOOP;

  FOR v_item IN
    SELECT * FROM comanda_itens WHERE comanda_id = p_comanda_id AND produto_id IS NOT NULL
  LOOP
    INSERT INTO venda_itens (empresa_id, venda_id, produto_id, quantidade, preco_unitario, subtotal, complementos)
    VALUES (v_emp, v_venda, v_item.produto_id::uuid, v_item.quantidade, v_item.preco_unitario,
            v_item.preco_unitario * v_item.quantidade, v_item.complementos);
    IF EXISTS (SELECT 1 FROM produtos WHERE id = v_item.produto_id::uuid AND COALESCE(controla_estoque, true) = true) THEN
      INSERT INTO estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao)
      VALUES (v_emp, v_item.produto_id::uuid, 'saida', v_item.quantidade, 'venda', v_obs);
    END IF;
  END LOOP;

  FOR v_pag IN SELECT * FROM jsonb_array_elements(p_pagamentos)
  LOOP
    -- 'fiado' NÃO vira linha de pagamento: é a ausência dela que faz o saldo devedor
    -- aparecer em clientes_saldo_fiado. Quando o cliente pagar, o recebimento é
    -- lançado no Portal Fiado e abate o saldo.
    IF (v_pag->>'valor')::numeric > 0 AND (v_pag->>'forma') <> 'fiado' THEN
      INSERT INTO pagamentos (empresa_id, venda_id, cliente_id, forma_pagamento, valor, observacao)
      VALUES (v_emp, v_venda, v_cliente,
              -- 'cashback' entrou na lista: sem isso ele cairia no ELSE e seria
              -- gravado como DINHEIRO, inflando o esperado da gaveta todo dia.
              CASE WHEN (v_pag->>'forma') IN ('dinheiro','pix','cartao','credito','debito','transferencia','cashback')
                   THEN v_pag->>'forma' ELSE 'dinheiro' END,
              (v_pag->>'valor')::numeric, v_obs);
    END IF;
  END LOOP;

  -- Baixa no saldo do cliente. Depois das vendas pra o extrato dele apontar pra
  -- venda certa — é por aí que a loja confere de onde saiu o desconto.
  IF v_cashback > 0 THEN
    PERFORM fidelidade_debitar(v_emp, v_dono, v_cashback,
              'Desconto na ' || rotulo_comanda(v_com), v_venda, NULL);
  END IF;

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

NOTIFY pgrst, 'reload schema';
