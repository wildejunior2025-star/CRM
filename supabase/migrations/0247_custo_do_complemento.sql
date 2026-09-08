-- 0247_custo_do_complemento.sql
-- Quanto o COMPLEMENTO custa pra loja.
--
-- O adicional sempre teve só o preço de venda: "QUEIJO MUSSARELA + R$ 2,00".
-- O dinheiro entrava no faturamento (o valor vai dentro do preço do item), mas
-- o custo não entrava em lugar nenhum — a opção não é produto, então não dá
-- baixa no estoque, e a conta do dia (custo_vendido_periodo) é por produto_id.
-- Resultado: cada R$ 2,00 de queijo aparecia como lucro inteiro, e o lucro do
-- dia saía maior do que é.
--
-- Agora é igual ao produto: o lojista digita o custo daquela opção.
ALTER TABLE public.complemento_opcoes
  ADD COLUMN IF NOT EXISTS preco_custo numeric;

COMMENT ON COLUMN public.complemento_opcoes.preco_custo IS
  'Quanto essa opção custa pra loja. Igual a produtos.preco_custo — digitado à mão.';

-- Pra somar o custo depois, a venda precisa dizer QUAIS opções o cliente
-- escolheu. Hoje isso se perde: a escolha vira texto dentro do nome do item
-- ("Cuscuz (QUEIJO MUSSARELA, OVO)") e não sobra id nenhum pra casar com o
-- cadastro. O delivery já guardava estruturado em pedidos_delivery.itens; o
-- salão e o cardápio do QR não guardavam.
--
-- Formato: [{ opcaoId, nome, preco, qtd, absoluto }] — o mesmo que o checkout
-- do delivery já grava. `absoluto` marca o grupo que vende por quantidade (o
-- "500× Leite condensado" do atacado), onde a qtd já é do total da linha e não
-- multiplica pela quantidade do item.
ALTER TABLE public.comanda_itens
  ADD COLUMN IF NOT EXISTS complementos jsonb;
ALTER TABLE public.venda_itens
  ADD COLUMN IF NOT EXISTS complementos jsonb;

CREATE OR REPLACE FUNCTION public.mesa_pedir(p_token text, p_itens jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mesa       mesas%ROWTYPE;
  v_emp        uuid;
  v_presencial boolean;
  v_comanda    uuid;
  v_item       jsonb;
  v_n          integer := 0;
BEGIN
  SELECT * INTO v_mesa FROM mesas WHERE token = p_token;
  IF v_mesa.id IS NULL THEN RAISE EXCEPTION 'Mesa não encontrada.'; END IF;
  IF NOT v_mesa.ativa THEN RAISE EXCEPTION 'Mesa indisponível.'; END IF;

  v_emp := v_mesa.empresa_id;
  SELECT presencial_ativo INTO v_presencial FROM empresas WHERE id = v_emp;
  IF NOT COALESCE(v_presencial, false) THEN
    RAISE EXCEPTION 'Pedido pela mesa indisponível no momento.';
  END IF;
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'Nenhum item no pedido.';
  END IF;

  SELECT id INTO v_comanda FROM comandas
  WHERE mesa_id = v_mesa.id AND status = 'aberta' ORDER BY created_at LIMIT 1;
  IF v_comanda IS NULL THEN
    INSERT INTO comandas (empresa_id, mesa_id, numero_mesa, status, observacoes)
    VALUES (v_emp, v_mesa.id, v_mesa.numero, 'aberta', 'Autoatendimento (QR)')
    RETURNING id INTO v_comanda;
    UPDATE mesas SET status = 'ocupada' WHERE id = v_mesa.id;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    INSERT INTO comanda_itens (empresa_id, comanda_id, produto_id, nome, preco_unitario, quantidade, observacao, status, complementos)
    VALUES (v_emp, v_comanda,
            NULLIF(v_item->>'produto_id',''),
            v_item->>'nome',
            COALESCE((v_item->>'preco')::numeric, 0),
            GREATEST(1, COALESCE((v_item->>'qtd')::int, 1)),
            NULLIF(v_item->>'obs',''),
            'pendente',
            CASE WHEN jsonb_typeof(v_item->'complementos') = 'array'
                 THEN v_item->'complementos' END);
    v_n := v_n + 1;
  END LOOP;

  RETURN json_build_object('ok', true, 'itens', v_n);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.cliente_pedir(p_token text, p_itens jsonb, p_senha text DEFAULT NULL::text, p_usar_cashback boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cli     clientes%ROWTYPE;
  v_emp     uuid;
  v_empresa empresas%ROWTYPE;
  v_comanda uuid;
  v_dia     date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_num     integer;
  v_item    jsonb;
  v_n       integer := 0;
BEGIN
  SELECT * INTO v_cli FROM clientes WHERE token = p_token;
  IF v_cli.id IS NULL THEN RAISE EXCEPTION 'Link nao encontrado.'; END IF;

  IF v_cli.senha_hash IS NULL THEN
    RAISE EXCEPTION 'SENHA_AUSENTE';
  END IF;
  IF NOT cliente_senha_ok(p_token, p_senha) THEN
    RAISE EXCEPTION 'SENHA_ERRADA';
  END IF;

  v_emp := v_cli.empresa_id;
  SELECT * INTO v_empresa FROM empresas WHERE id = v_emp;
  IF NOT COALESCE(v_empresa.link_cliente_ativo, false) THEN
    RAISE EXCEPTION 'A loja nao esta aceitando pedido por link agora.';
  END IF;
  IF NOT COALESCE(v_empresa.presencial_ativo, false) THEN
    RAISE EXCEPTION 'Pedido indisponivel no momento.';
  END IF;
  IF NOT loja_aberta_agora(v_emp) THEN
    RAISE EXCEPTION 'A loja esta fechada agora. Faca o pedido no horario de funcionamento.';
  END IF;
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'Nenhum item no pedido.';
  END IF;

  SELECT id INTO v_comanda FROM comandas
  WHERE empresa_id = v_emp AND cliente_id = v_cli.id AND status = 'aberta'
  ORDER BY created_at LIMIT 1;

  IF v_comanda IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_emp::text || v_dia::text));
    SELECT COALESCE(MAX(numero_mesa), 0) + 1 INTO v_num
    FROM comandas WHERE empresa_id = v_emp AND tipo = 'balcao' AND dia = v_dia;

    INSERT INTO comandas (empresa_id, mesa_id, numero_mesa, tipo, nome_cliente, dia,
                          cliente_id, status, observacoes, usar_cashback, visto_em)
    VALUES (v_emp, NULL, v_num, 'balcao', v_cli.nome, v_dia,
            v_cli.id, 'aberta', 'Pedido pelo link do cliente', COALESCE(p_usar_cashback, false), NULL)
    RETURNING id INTO v_comanda;
  ELSE
    UPDATE comandas
       SET visto_em = NULL,
           usar_cashback = usar_cashback OR COALESCE(p_usar_cashback, false)
     WHERE id = v_comanda;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    INSERT INTO comanda_itens (empresa_id, comanda_id, produto_id, nome, preco_unitario, quantidade, observacao, status, complementos)
    VALUES (v_emp, v_comanda,
            NULLIF(v_item->>'produto_id',''),
            v_item->>'nome',
            COALESCE((v_item->>'preco')::numeric, 0),
            GREATEST(1, COALESCE((v_item->>'qtd')::int, 1)),
            NULLIF(v_item->>'obs',''),
            'pendente',
            CASE WHEN jsonb_typeof(v_item->'complementos') = 'array'
                 THEN v_item->'complementos' END);
    v_n := v_n + 1;
  END LOOP;

  RETURN json_build_object('ok', true, 'itens', v_n, 'comanda_id', v_comanda);
END;
$function$
;

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
$function$
;

-- Custo dos complementos vendidos no período.
--
-- Espelha custo_vendido_periodo, que faz o mesmo pro produto. Fica em função
-- separada de propósito: aquela é por produto_id e o complemento não tem um —
-- juntar as duas obrigaria a mexer na conta que já funciona.
--
-- A regra de preço do grupo ("maior", do meio a meio) NÃO vale aqui: o cliente
-- pode pagar só pela metade mais cara, mas as duas metades saem da sua geladeira.
-- Custo é sempre soma.
CREATE OR REPLACE FUNCTION public.custo_complementos_periodo(
  p_ini timestamptz, p_fim timestamptz)
RETURNS TABLE(opcao_id uuid, nome text, grupo text, custo_unit numeric, qtd numeric, custo numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with escolhas as (
    -- Salão, mesa e link do cliente: a venda guarda a montagem.
    select (c->>'opcaoId')::uuid as opcao_id,
           coalesce(nullif(c->>'qtd','')::numeric, 1)
             * case when coalesce((c->>'absoluto')::boolean, false)
                    then 1 else coalesce(vi.quantidade, 1) end as qtd
    from venda_itens vi
    join vendas v on v.id = vi.venda_id
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(vi.complementos) = 'array' then vi.complementos else '[]'::jsonb end) c
    where vi.empresa_id = current_empresa_id()
      and v.status <> 'cancelado'
      and v.created_at >= p_ini and v.created_at < p_fim
      and c->>'opcaoId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

    union all

    -- Delivery e loja online: o pedido já guardava estruturado.
    select (c->>'opcaoId')::uuid,
           coalesce(nullif(c->>'qtd','')::numeric, 1)
             * case when coalesce((c->>'absoluto')::boolean, false) then 1
                    else coalesce(nullif(it->>'quantidade','')::numeric,
                                  nullif(it->>'qtd','')::numeric, 1) end
    from pedidos_delivery pd
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(pd.itens) = 'array' then pd.itens else '[]'::jsonb end) it
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(it->'complementos') = 'array' then it->'complementos' else '[]'::jsonb end) c
    where pd.empresa_id = current_empresa_id()
      and pd.status <> 'cancelado'
      and pd.created_at >= p_ini and pd.created_at < p_fim
      and c->>'opcaoId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  )
  select o.id, o.nome, g.nome, o.preco_custo,
         round(sum(e.qtd), 3) as qtd,
         round(sum(e.qtd) * o.preco_custo, 2) as custo
  from escolhas e
  join complemento_opcoes o on o.id = e.opcao_id
  join complemento_grupos g on g.id = o.grupo_id
  where g.empresa_id = current_empresa_id()
    and coalesce(o.preco_custo, 0) > 0
  group by o.id, o.nome, g.nome, o.preco_custo
  order by 6 desc;
$function$;

GRANT EXECUTE ON FUNCTION public.custo_complementos_periodo(timestamptz, timestamptz) TO authenticated;
