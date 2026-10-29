-- EDITAR E CANCELAR CONTA JÁ FECHADA (29/10/2026)
--
-- O dono fecha a mesa e só depois vê que lançou o produto errado — ou o cliente
-- volta pra devolver um item estragado (mercadinho). No histórico só dava pra
-- trocar a FORMA de pagamento; os itens ficavam travados (trava_comanda_fechada)
-- e cancelar a conta inteira também não existia.
--
-- Duas funções, só pro ADM:
--   editar_conta_fechada   — troca a lista de itens e acerta tudo pela DIFERENÇA
--   cancelar_conta_fechada — desfaz a conta inteira
--
-- O DINHEIRO NUNCA É APAGADO, É ESTORNADO. O pagamento original continua no
-- caixa em que entrou; a diferença (ou o estorno) entra como um pagamento novo,
-- negativo quando a loja devolve, no caixa/dia de HOJE. É o que bate com a
-- gaveta: o dinheiro entrou naquele dia e saiu neste. Apagar o pagamento antigo
-- mudaria um caixa que já foi conferido e fechado.
--
-- ESTOQUE E INSUMOS TAMBÉM PELA DIFERENÇA. venda_itens tem um gatilho que baixa
-- a matéria-prima da ficha técnica a cada INSERT (trg_venda_item_mp). Refazer a
-- lista de venda_itens baixaria tudo de novo — por isso o gatilho fica calado
-- durante a edição e a função lança só o que mudou, produto por produto.
--
-- Conta com NFC-e autorizada não muda: a nota diria uma coisa e a venda outra.
-- Cancela a nota primeiro.

-- 1) Sinal de "edição de conta fechada em andamento", só dentro da transação
--    das funções abaixo (set_config(..., true)). Os gatilhos olham pra ele.

CREATE OR REPLACE FUNCTION public.editando_conta_fechada()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$ SELECT COALESCE(current_setting('fwc.editando_conta', true), '') = 'on' $$;

-- Trava da comanda fechada: deixa passar quando quem mexe é a edição do ADM.
-- (Gatilho NÃO é security definer — fica como estava.)
CREATE OR REPLACE FUNCTION public.trava_comanda_fechada()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_id uuid := coalesce(new.comanda_id, old.comanda_id);
  v_status text;
begin
  -- Edição da conta fechada pelo ADM (editar_conta_fechada): é ela que acerta
  -- dinheiro, estoque e venda junto, por isso pode mexer.
  if public.editando_conta_fechada() then return coalesce(new, old); end if;

  select status into v_status from comandas where id = v_id;
  -- Comanda sumindo junto (cascata de exclusao da loja): nao e edicao.
  if not found then return coalesce(new, old); end if;
  if v_status = 'aberta' then return coalesce(new, old); end if;

  -- A cozinha continua podendo marcar pronto/entregue depois de a conta fechar:
  -- o papel pode sair antes de o prato ficar pronto. O que trava e o que mexe
  -- no DINHEIRO - item novo, item apagado, quantidade ou preco.
  if tg_op = 'UPDATE'
     and new.quantidade     is not distinct from old.quantidade
     and new.preco_unitario is not distinct from old.preco_unitario
     and new.comanda_id     is not distinct from old.comanda_id then
    return new;
  end if;

  raise exception
    'Esta comanda já foi fechada e não aceita mais mudança. Abra uma comanda nova pra lançar.'
    using errcode = 'P0001';
end $function$;

-- Item tirado na edição não vira "item removido" solto: a edição grava UM
-- registro dizendo tudo o que mudou (tipo conta_editada).
CREATE OR REPLACE FUNCTION public.log_item_removido()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_rot text;
begin
  if public.editando_conta_fechada() then return null; end if;

  -- Cascata (comanda ou loja apagada) nao e remocao de item: a comanda ja sumiu.
  select rotulo_comanda(c) into v_rot from comandas c where c.id = old.comanda_id;
  if not found then return null; end if;

  insert into comanda_eventos (empresa_id, comanda_id, rotulo, tipo, quem, descricao, quantidade, valor)
  values (old.empresa_id, old.comanda_id, v_rot, 'item_removido', auth.uid(),
          old.nome, old.quantidade,
          round(coalesce(old.preco_unitario,0) * coalesce(old.quantidade,0), 2));
  return null;
end $function$;

-- Insumos da ficha técnica: na edição a função lança só a diferença.
CREATE OR REPLACE FUNCTION public.trg_venda_item_mp()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_linha record;
BEGIN
  IF public.editando_conta_fechada() THEN RETURN NULL; END IF;
  IF NEW.produto_id IS NULL OR NEW.empresa_id IS NULL OR COALESCE(NEW.quantidade, 0) <= 0 THEN
    RETURN NULL;
  END IF;
  FOR v_linha IN SELECT * FROM mp_consumo_do_produto(NEW.produto_id::uuid, NEW.quantidade::numeric, now())
  LOOP
    INSERT INTO materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao)
    VALUES (NEW.empresa_id, v_linha.materia_prima_id, 'saida', v_linha.quantidade,
            'Venda no salão · ' || NEW.venda_id::text);
  END LOOP;
  RETURN NULL;
END;
$function$;

-- Novo tipo de registro na trilha "Cancelamentos e itens removidos".
ALTER TABLE public.comanda_eventos DROP CONSTRAINT IF EXISTS comanda_eventos_tipo_check;
ALTER TABLE public.comanda_eventos ADD CONSTRAINT comanda_eventos_tipo_check
  CHECK (tipo = ANY (ARRAY['item_removido'::text, 'comanda_cancelada'::text, 'conta_editada'::text]));

-- 2) Estoque + insumos de um produto, por diferença de quantidade.
--    p_qtd > 0 = saiu mais (baixa); p_qtd < 0 = voltou (entrada).
CREATE OR REPLACE FUNCTION public.ajustar_estoque_conta(p_emp uuid, p_produto uuid, p_qtd numeric, p_obs text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_linha record;
BEGIN
  IF p_produto IS NULL OR COALESCE(p_qtd, 0) = 0 THEN RETURN; END IF;

  -- avisado_em já preenchido: devolução de conta não é "entrou mercadoria" e
  -- não pode disparar o aviso de entrada no estoque pro dono (mig 0370).
  IF EXISTS (SELECT 1 FROM produtos WHERE id = p_produto AND COALESCE(controla_estoque, true) = true) THEN
    INSERT INTO estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao, avisado_em)
    VALUES (p_emp, p_produto,
            CASE WHEN p_qtd > 0 THEN 'saida' ELSE 'entrada' END,
            ABS(p_qtd),
            CASE WHEN p_qtd > 0 THEN 'venda' ELSE 'devolucao' END,
            p_obs, now());
  END IF;

  FOR v_linha IN SELECT * FROM mp_consumo_do_produto(p_produto, ABS(p_qtd), now())
  LOOP
    INSERT INTO materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, avisado_em)
    VALUES (p_emp, v_linha.materia_prima_id,
            CASE WHEN p_qtd > 0 THEN 'saida' ELSE 'entrada' END,
            v_linha.quantidade, p_obs, now());
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.ajustar_estoque_conta(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;

-- produto_id da comanda é text e pode ser avulso ("inventar produto").
CREATE OR REPLACE FUNCTION public.uuid_ou_nulo(p text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN NULLIF(BTRIM(p), '')::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- 3) EDITAR os itens de uma conta fechada.
--
-- p_itens = a lista FINAL da conta: [{id?, produto_id?, nome, preco_unitario, quantidade}].
--   com id   → item que já estava (quantidade/preço podem mudar)
--   sem id   → item novo
--   id que não veio → item tirado
-- p_forma_diferenca: em que forma a diferença foi cobrada (conta subiu) ou
--   devolvida (conta desceu). Pode ficar nula quando a conta foi paga numa
--   forma só — aí vai nela.
CREATE OR REPLACE FUNCTION public.editar_conta_fechada(
  p_comanda_id uuid, p_itens jsonb, p_forma_diferenca text DEFAULT NULL, p_motivo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_emp      uuid := current_empresa_id();
  v_perfil   text;
  v_com      comandas%ROWTYPE;
  v_venda    vendas%ROWTYPE;
  v_vivas    integer;
  v_pct      numeric;
  v_base_old numeric;
  v_taxa_pct_old numeric;
  v_aplicou  boolean;
  v_gorjeta  numeric;
  v_sub      numeric;
  v_base     numeric;
  v_taxa     numeric;
  v_total    numeric;
  v_dif      numeric;
  v_forma    text;
  v_rot      text;
  v_obs      text;
  v_mudou    text := '';
  v_el       jsonb;
  v_id       uuid;
  v_old      comanda_itens%ROWTYPE;
  v_qtd      numeric;
  v_preco    numeric;
  v_nome     text;
  r          record;
BEGIN
  SELECT perfil INTO v_perfil FROM profiles WHERE id = auth.uid();
  IF COALESCE(v_perfil, '') NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'Só o administrador pode mexer numa conta já fechada.';
  END IF;

  SELECT * INTO v_com FROM comandas
   WHERE id = p_comanda_id AND empresa_id = v_emp AND status = 'fechada'
   FOR UPDATE;
  IF v_com.id IS NULL THEN RAISE EXCEPTION 'Conta não encontrada ou não está fechada.'; END IF;

  IF EXISTS (SELECT 1 FROM nfce_notas WHERE comanda_id = p_comanda_id AND status IN ('autorizada', 'processando')) THEN
    RAISE EXCEPTION 'Esta conta tem nota fiscal emitida. Cancele a nota primeiro e depois edite a conta.';
  END IF;

  SELECT COUNT(*) INTO v_vivas FROM vendas WHERE comanda_id = p_comanda_id AND status <> 'cancelado';
  IF v_vivas > 1 THEN
    RAISE EXCEPTION 'Esta conta foi dividida no fiado entre clientes. Pra mudar, cancele a conta e lance de novo.';
  END IF;
  SELECT * INTO v_venda FROM vendas WHERE id = v_com.venda_id;
  IF v_venda.id IS NULL OR v_venda.status = 'cancelado' THEN
    RAISE EXCEPTION 'Esta conta é antiga e não tem venda ligada — não dá pra editar por aqui.';
  END IF;

  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'A conta ficaria sem nenhum item. Pra desfazer tudo, use "Cancelar a conta".';
  END IF;

  FOR v_el IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    IF COALESCE((v_el->>'quantidade')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'Quantidade tem que ser maior que zero (%).', COALESCE(v_el->>'nome', 'item');
    END IF;
    IF COALESCE((v_el->>'preco_unitario')::numeric, -1) < 0 THEN
      RAISE EXCEPTION 'Preço inválido (%).', COALESCE(v_el->>'nome', 'item');
    END IF;
    IF NULLIF(v_el->>'id', '') IS NULL AND NULLIF(BTRIM(v_el->>'nome'), '') IS NULL THEN
      RAISE EXCEPTION 'Item novo sem nome.';
    END IF;
    IF NULLIF(v_el->>'id', '') IS NULL AND uuid_ou_nulo(v_el->>'produto_id') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM produtos WHERE id = uuid_ou_nulo(v_el->>'produto_id') AND empresa_id = v_emp) THEN
      RAISE EXCEPTION 'Produto não encontrado nesta loja (%).', v_el->>'nome';
    END IF;
  END LOOP;

  v_rot := rotulo_comanda(v_com);
  v_obs := 'Ajuste da conta · ' || v_rot
           || COALESCE(' · ' || NULLIF(BTRIM(p_motivo), ''), '');

  -- Como a taxa foi cobrada no fechamento: % da loja (sim/não) + gorjeta à parte.
  SELECT COALESCE(taxa_servico_pct, 10) INTO v_pct FROM empresas WHERE id = v_emp;
  SELECT COALESCE(SUM(preco_unitario * quantidade), 0) INTO v_base_old
    FROM comanda_itens WHERE comanda_id = p_comanda_id AND isento_taxa IS NOT TRUE;
  v_taxa_pct_old := ROUND(v_base_old * v_pct / 100.0, 2);
  v_aplicou := v_base_old > 0 AND v_taxa_pct_old > 0 AND v_com.taxa_servico >= v_taxa_pct_old - 0.01;
  v_gorjeta := GREATEST(v_com.taxa_servico - CASE WHEN v_aplicou THEN v_taxa_pct_old ELSE 0 END, 0);

  -- Quantidade por produto ANTES (pra acertar estoque e insumos pela diferença).
  CREATE TEMP TABLE IF NOT EXISTS _conta_qtd (produto uuid PRIMARY KEY, antes numeric, depois numeric) ON COMMIT DROP;
  TRUNCATE _conta_qtd;
  INSERT INTO _conta_qtd (produto, antes, depois)
  SELECT uuid_ou_nulo(produto_id), SUM(quantidade), 0
    FROM comanda_itens
   WHERE comanda_id = p_comanda_id AND uuid_ou_nulo(produto_id) IS NOT NULL
   GROUP BY 1;

  PERFORM set_config('fwc.editando_conta', 'on', true);

  -- Tirados
  FOR v_old IN
    SELECT * FROM comanda_itens i
     WHERE i.comanda_id = p_comanda_id
       AND i.id NOT IN (SELECT uuid_ou_nulo(x->>'id') FROM jsonb_array_elements(p_itens) x
                         WHERE uuid_ou_nulo(x->>'id') IS NOT NULL)
  LOOP
    v_mudou := v_mudou || '; tirou ' || TRIM(TO_CHAR(v_old.quantidade, 'FM999990.###')) || 'x ' || v_old.nome;
    DELETE FROM comanda_itens WHERE id = v_old.id;
  END LOOP;

  FOR v_el IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    v_id    := uuid_ou_nulo(v_el->>'id');
    v_qtd   := (v_el->>'quantidade')::numeric;
    v_preco := ROUND((v_el->>'preco_unitario')::numeric, 2);
    IF v_id IS NOT NULL THEN
      SELECT * INTO v_old FROM comanda_itens WHERE id = v_id AND comanda_id = p_comanda_id;
      IF v_old.id IS NULL THEN RAISE EXCEPTION 'Item não pertence a esta conta.'; END IF;
      IF v_old.quantidade <> v_qtd OR v_old.preco_unitario <> v_preco THEN
        v_mudou := v_mudou || '; ' || v_old.nome || ': '
                   || CASE WHEN v_old.quantidade <> v_qtd
                           THEN TRIM(TO_CHAR(v_old.quantidade, 'FM999990.###')) || '→' || TRIM(TO_CHAR(v_qtd, 'FM999990.###')) || ' un' ELSE '' END
                   || CASE WHEN v_old.quantidade <> v_qtd AND v_old.preco_unitario <> v_preco THEN ', ' ELSE '' END
                   || CASE WHEN v_old.preco_unitario <> v_preco
                           THEN 'R$ ' || TO_CHAR(v_old.preco_unitario, 'FM999990.00') || '→' || TO_CHAR(v_preco, 'FM999990.00') ELSE '' END;
        UPDATE comanda_itens SET quantidade = v_qtd, preco_unitario = v_preco WHERE id = v_id;
      END IF;
    ELSE
      v_nome := BTRIM(v_el->>'nome');
      -- 'entregue': a impressora da cozinha e a tela da cozinha só pegam item
      -- 'pendente'. Item posto na conta depois de fechada não vai pra cozinha.
      INSERT INTO comanda_itens (empresa_id, comanda_id, produto_id, nome, preco_unitario, quantidade, status, lancado_por, entregue_at)
      VALUES (v_emp, p_comanda_id, NULLIF(v_el->>'produto_id', ''), v_nome, v_preco, v_qtd, 'entregue', auth.uid(), now());
      v_mudou := v_mudou || '; pôs ' || TRIM(TO_CHAR(v_qtd, 'FM999990.###')) || 'x ' || v_nome;
    END IF;
  END LOOP;

  IF v_mudou = '' THEN
    PERFORM set_config('fwc.editando_conta', '', true);
    RETURN jsonb_build_object('diferenca', 0, 'total', v_com.total, 'mudou', false);
  END IF;
  v_mudou := SUBSTRING(v_mudou FROM 3);

  -- Números novos, com a mesma regra de taxa do fechamento.
  SELECT COALESCE(SUM(preco_unitario * quantidade), 0) INTO v_sub
    FROM comanda_itens WHERE comanda_id = p_comanda_id;
  SELECT COALESCE(SUM(preco_unitario * quantidade), 0) INTO v_base
    FROM comanda_itens WHERE comanda_id = p_comanda_id AND isento_taxa IS NOT TRUE;
  v_taxa  := CASE WHEN v_aplicou THEN ROUND(v_base * v_pct / 100.0, 2) ELSE 0 END + v_gorjeta;
  v_total := ROUND(v_sub + v_taxa, 2);
  v_dif   := ROUND(v_total - v_com.total, 2);

  -- Estoque e insumos: só o que mudou.
  INSERT INTO _conta_qtd (produto, antes, depois)
  SELECT uuid_ou_nulo(produto_id), 0, SUM(quantidade)
    FROM comanda_itens
   WHERE comanda_id = p_comanda_id AND uuid_ou_nulo(produto_id) IS NOT NULL
   GROUP BY 1
  ON CONFLICT (produto) DO UPDATE SET depois = EXCLUDED.depois;
  FOR r IN SELECT produto, depois - antes AS dif FROM _conta_qtd WHERE depois <> antes LOOP
    PERFORM ajustar_estoque_conta(v_emp, r.produto, r.dif, v_obs);
  END LOOP;

  -- Itens da venda espelham a comanda (o gatilho de insumos está calado).
  DELETE FROM venda_itens WHERE venda_id = v_venda.id;
  INSERT INTO venda_itens (empresa_id, venda_id, produto_id, quantidade, preco_unitario, subtotal, complementos)
  SELECT v_emp, v_venda.id, uuid_ou_nulo(produto_id), quantidade, preco_unitario,
         preco_unitario * quantidade, complementos
    FROM comanda_itens
   WHERE comanda_id = p_comanda_id AND uuid_ou_nulo(produto_id) IS NOT NULL;

  PERFORM set_config('fwc.editando_conta', '', true);

  -- Dinheiro.
  IF ABS(v_dif) >= 0.005 THEN
    IF v_venda.forma_pagamento = 'fiado' THEN
      -- Fiado: a loja não recebeu, então a diferença mexe na dívida.
      UPDATE vendas SET total = ROUND(total + v_dif, 2) WHERE id = v_venda.id;
      v_forma := 'fiado';
    ELSE
      v_forma := lower(btrim(COALESCE(NULLIF(p_forma_diferenca, ''),
                   CASE WHEN v_com.forma_pagamento NOT IN ('dividido', 'fiado') THEN v_com.forma_pagamento END)));
      IF v_forma IS NULL THEN
        RAISE EXCEPTION 'A conta foi paga em mais de uma forma. Escolha em qual forma a diferença foi %.',
          CASE WHEN v_dif > 0 THEN 'cobrada' ELSE 'devolvida' END;
      END IF;
      IF v_forma NOT IN ('dinheiro','pix','cartao','credito','debito','transferencia','pluxee','alelo','vr','ticket') THEN
        RAISE EXCEPTION 'Forma inválida pra diferença: %.', v_forma;
      END IF;
      IF v_total < 0.005 THEN
        RAISE EXCEPTION 'A conta ficaria zerada. Use "Cancelar a conta".';
      END IF;
      -- Pagamento novo, HOJE: positivo se cobrou mais, negativo se devolveu.
      INSERT INTO pagamentos (empresa_id, venda_id, cliente_id, forma_pagamento, valor, observacao)
      VALUES (v_emp, v_venda.id, v_venda.cliente_id, v_forma, v_dif, v_obs);
      UPDATE vendas SET total = ROUND(total + v_dif, 2) WHERE id = v_venda.id;
    END IF;
  END IF;

  UPDATE comandas
     SET subtotal = v_sub, taxa_servico = v_taxa, total = v_total,
         forma_pagamento = CASE
           WHEN v_forma IS NOT NULL AND v_forma <> 'fiado'
                AND COALESCE(forma_pagamento, '') NOT IN ('dividido', v_forma)
           THEN 'dividido' ELSE forma_pagamento END
   WHERE id = p_comanda_id;

  INSERT INTO comanda_eventos (empresa_id, comanda_id, rotulo, tipo, quem, descricao, quantidade, valor)
  VALUES (v_emp, p_comanda_id, v_rot, 'conta_editada', auth.uid(),
          v_mudou
          || CASE WHEN ABS(v_dif) >= 0.005
                  THEN ' · ' || CASE WHEN v_dif > 0 THEN 'cobrou mais' ELSE 'devolveu' END
                       || ' R$ ' || TO_CHAR(ABS(v_dif), 'FM999990.00')
                       || CASE WHEN v_forma IS NOT NULL THEN ' (' || v_forma || ')' ELSE '' END
                  ELSE '' END
          || COALESCE(' · motivo: ' || NULLIF(BTRIM(p_motivo), ''), ''),
          NULL, v_dif);

  RETURN jsonb_build_object('diferenca', v_dif, 'total', v_total, 'forma', v_forma, 'mudou', true);
END;
$$;
REVOKE ALL ON FUNCTION public.editar_conta_fechada(uuid, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.editar_conta_fechada(uuid, jsonb, text, text) TO authenticated;

-- 4) CANCELAR a conta fechada inteira.
CREATE OR REPLACE FUNCTION public.cancelar_conta_fechada(p_comanda_id uuid, p_motivo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_emp     uuid := current_empresa_id();
  v_perfil  text;
  v_com     comandas%ROWTYPE;
  v_rot     text;
  v_obs     text;
  v_est     numeric := 0;
  r         record;
BEGIN
  SELECT perfil INTO v_perfil FROM profiles WHERE id = auth.uid();
  IF COALESCE(v_perfil, '') NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'Só o administrador pode cancelar uma conta já fechada.';
  END IF;

  SELECT * INTO v_com FROM comandas
   WHERE id = p_comanda_id AND empresa_id = v_emp AND status = 'fechada'
   FOR UPDATE;
  IF v_com.id IS NULL THEN RAISE EXCEPTION 'Conta não encontrada ou não está fechada.'; END IF;

  IF EXISTS (SELECT 1 FROM nfce_notas WHERE comanda_id = p_comanda_id AND status IN ('autorizada', 'processando')) THEN
    RAISE EXCEPTION 'Esta conta tem nota fiscal emitida. Cancele a nota primeiro e depois cancele a conta.';
  END IF;

  v_rot := rotulo_comanda(v_com);
  v_obs := 'Estorno · ' || v_rot || COALESCE(' · ' || NULLIF(BTRIM(p_motivo), ''), '');

  -- Dinheiro: devolve o que entrou, forma por forma, HOJE.
  FOR r IN
    SELECT p.forma_pagamento AS forma, v.cliente_id, MIN(v.id::text)::uuid AS venda_id, ROUND(SUM(p.valor), 2) AS valor
      FROM pagamentos p
      JOIN vendas v ON v.id = p.venda_id
     WHERE v.comanda_id = p_comanda_id AND v.status <> 'cancelado'
     GROUP BY p.forma_pagamento, v.cliente_id
    HAVING ABS(SUM(p.valor)) >= 0.005
  LOOP
    INSERT INTO pagamentos (empresa_id, venda_id, cliente_id, forma_pagamento, valor, observacao)
    VALUES (v_emp, r.venda_id, r.cliente_id, r.forma, -r.valor, v_obs);
    v_est := v_est + r.valor;
    -- Crédito (cashback) usado na conta volta pro cliente.
    IF r.forma = 'cashback' AND r.valor > 0 THEN
      PERFORM fidelidade_estornar(v_emp, r.cliente_id, r.valor, 'Conta cancelada · ' || v_rot, NULL);
    END IF;
  END LOOP;

  -- Estoque e insumos voltam.
  FOR r IN
    SELECT uuid_ou_nulo(produto_id) AS produto, SUM(quantidade) AS qtd
      FROM comanda_itens
     WHERE comanda_id = p_comanda_id AND uuid_ou_nulo(produto_id) IS NOT NULL
     GROUP BY 1
  LOOP
    PERFORM ajustar_estoque_conta(v_emp, r.produto, -r.qtd, v_obs);
  END LOOP;

  -- Vendas (à vista e fiado) canceladas: somem do faturamento e o fiado sai da
  -- dívida. O gatilho de cancelamento estorna o cashback que a conta GEROU.
  UPDATE vendas
     SET status = 'cancelado',
         observacoes = COALESCE(observacoes, '') || ' · CONTA CANCELADA pelo ADM'
                       || COALESCE(': ' || NULLIF(BTRIM(p_motivo), ''), '')
   WHERE comanda_id = p_comanda_id AND status <> 'cancelado';

  UPDATE comandas SET status = 'cancelada' WHERE id = p_comanda_id;

  -- O gatilho log_comanda_cancelada acabou de gravar o registro; completa com o motivo.
  UPDATE comanda_eventos
     SET descricao = 'Conta já fechada · ' || descricao
                     || CASE WHEN v_est <> 0 THEN ' · estornou R$ ' || TO_CHAR(v_est, 'FM999990.00') ELSE ' · era fiado' END
                     || COALESCE(' · motivo: ' || NULLIF(BTRIM(p_motivo), ''), ''),
         valor = v_com.total
   WHERE id = (SELECT id FROM comanda_eventos
                WHERE comanda_id = p_comanda_id AND tipo = 'comanda_cancelada'
                ORDER BY quando DESC LIMIT 1);

  RETURN jsonb_build_object('estornado', v_est, 'total', v_com.total);
END;
$$;
REVOKE ALL ON FUNCTION public.cancelar_conta_fechada(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_conta_fechada(uuid, text) TO authenticated;
