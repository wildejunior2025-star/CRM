-- 0405 — A COMPRA ATUALIZA O CUSTO PELA MÉDIA, NÃO PELO ÚLTIMO PREÇO
--
-- 26/10/2026 (AGV Grill): tinha 5 unidades a R$ 5,00 e comprou mais 10 a R$ 4,50. O sistema
-- gravava o custo do cadastro como 4,50 — o preço da ÚLTIMA compra — e passava a valorizar as 15
-- unidades (inclusive as 5 antigas) e o lucro da venda a 4,50. O certo é o CUSTO MÉDIO PONDERADO:
--   (5 × 5,00 + 10 × 4,50) / 15 = 4,6667
--
-- Regras:
--  * só entra na média o saldo POSITIVO (estoque negativo é erro de contagem, não mercadoria);
--  * se o cadastro não tinha custo (0), não há o que ponderar: vale o preço pago;
--  * produto que não controla estoque não tem saldo: vale o último preço pago;
--  * o movimento continua guardando o PREÇO PAGO (custo_unit) — a média só vive no cadastro.
--
-- O DESFAZER passa a conferir o custo que a compra deixou (`custo_depois`), não o preço pago, que
-- agora é diferente. Compras antigas (sem custo_depois) seguem o comportamento de antes.
--
-- Só a tela "Lançar compra" usa isto. As outras entradas (Entrada de estoque, robô do WhatsApp)
-- ainda gravam o último preço.

create or replace function lancar_compra(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_emp     uuid := current_empresa_id();
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_data    date := coalesce(nullif(p->>'data', '')::date, v_hoje);
  v_venc    date := coalesce(nullif(p->>'vencimento', '')::date, v_data);
  v_total   numeric := round(coalesce((p->>'total')::numeric, 0), 2);
  v_pago    boolean := coalesce((p->>'pago')::boolean, false);
  v_forn    text := btrim(coalesce(p->>'fornecedor', ''));
  v_compra  uuid := gen_random_uuid();
  v_conta   uuid;
  it        jsonb;
  v_feitos  jsonb := '[]'::jsonb;
  v_id      uuid;
  v_qtd     numeric;
  v_custo   numeric;
  v_valor   numeric;
  v_antes   numeric;
  v_depois  numeric;
  v_saldo   numeric;
  v_tipo    text;
  v_item    uuid;
  v_ctrl    boolean;
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja lança compra.';
  end if;
  if v_forn = '' then raise exception 'Diga de quem foi a compra (fornecedor).'; end if;
  if jsonb_typeof(p->'itens') <> 'array' or jsonb_array_length(p->'itens') = 0 then
    raise exception 'A compra está sem itens.';
  end if;
  if v_total <= 0 then raise exception 'O total da compra precisa ser maior que zero.'; end if;

  insert into contas_financeiras (empresa_id, tipo, descricao, pessoa, categoria, valor, vencimento, rateio, recorrencia, origem)
  values (v_emp, 'pagar', 'Compra — ' || v_forn, v_forn, coalesce(nullif(p->>'categoria', ''), 'Fornecedores'),
          v_total, case when v_pago then v_data else v_venc end,
          case when jsonb_typeof(p->'rateio') = 'array' and jsonb_array_length(p->'rateio') > 0 then p->'rateio' end,
          'nenhuma', 'portal')
  returning id into v_conta;

  if v_pago then
    insert into contas_baixas (empresa_id, conta_id, valor, data, forma, origem)
    values (v_emp, v_conta, v_total, v_data, nullif(p->>'forma', ''), 'portal');
  end if;

  for it in select * from jsonb_array_elements(p->'itens') loop
    v_tipo  := it->>'tipo';
    v_item  := (it->>'id')::uuid;
    v_qtd   := coalesce((it->>'quantidade')::numeric, 0);
    v_custo := nullif((it->>'custo_unit')::numeric, 0);
    if v_qtd <= 0 then raise exception 'Item "%" está com quantidade zerada.', coalesce(it->>'nome', '?'); end if;
    v_valor := case when v_custo is null then null else round(v_custo * v_qtd, 2) end;
    v_id := null; v_antes := null; v_depois := null; v_saldo := 0;

    if v_tipo = 'produto' then
      if not exists (select 1 from produtos where id = v_item and empresa_id = v_emp) then
        raise exception 'Produto "%" não é desta loja.', coalesce(it->>'nome', '?');
      end if;
      select preco_custo into v_antes from produtos where id = v_item;
      v_ctrl := coalesce((it->>'estoque')::boolean, true);
      if v_ctrl then
        -- o saldo ANTES desta compra (a conta usa o estoque que existia, não o que vai existir)
        select coalesce(sum(case when tipo = 'entrada' then quantidade when tipo = 'saida' then -quantidade
                                 when tipo = 'ajuste' then quantidade else 0 end), 0)
          into v_saldo from estoque_movimentos where produto_id = v_item;
        insert into estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao, custo_unit, valor_total)
        values (v_emp, v_item, 'entrada', v_qtd, 'compra', 'Compra lançada — ' || v_forn, v_custo, v_valor)
        returning id into v_id;     -- null quando a loja está com o estoque desligado (gatilho ignora)
      end if;
      if v_custo is not null then
        v_depois := case when v_ctrl and v_id is not null and v_saldo > 0 and coalesce(v_antes, 0) > 0
                         then round((v_saldo * v_antes + v_qtd * v_custo) / (v_saldo + v_qtd), 4)
                         else v_custo end;
        -- preco_custo é numeric(12,2): guarda já arredondado, senão o DESFAZER não reconhece o valor.
        v_depois := round(v_depois, 2);
        update produtos set preco_custo = v_depois where id = v_item;
      end if;

    elsif v_tipo = 'materia' then
      if not exists (select 1 from materias_primas where id = v_item and empresa_id = v_emp) then
        raise exception 'Matéria-prima "%" não é desta loja.', coalesce(it->>'nome', '?');
      end if;
      select custo into v_antes from materias_primas where id = v_item;
      select coalesce(sum(case when tipo = 'entrada' then quantidade when tipo = 'saida' then -quantidade
                               when tipo = 'ajuste' then quantidade else 0 end), 0)
        into v_saldo from materia_prima_movimentos where materia_prima_id = v_item;
      insert into materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, custo_unit, valor_total)
      values (v_emp, v_item, 'entrada', v_qtd, 'Compra lançada — ' || v_forn, v_custo, v_valor)
      returning id into v_id;
      if v_custo is not null then
        v_depois := case when v_saldo > 0 and coalesce(v_antes, 0) > 0
                         then round((v_saldo * v_antes + v_qtd * v_custo) / (v_saldo + v_qtd), 4)
                         else v_custo end;
        update materias_primas set custo = v_depois where id = v_item;
      end if;
    else
      raise exception 'Tipo de item inválido: %', v_tipo;
    end if;

    v_feitos := v_feitos || jsonb_build_array(it || jsonb_build_object(
      'mov_id', v_id, 'custo_antes', v_antes, 'custo_depois', v_depois, 'saldo_antes', v_saldo));
  end loop;

  insert into compras_lancadas (id, empresa_id, fornecedor, data, total, pago, conta_id, itens)
  values (v_compra, v_emp, v_forn, v_data, v_total, v_pago, v_conta, v_feitos);

  return v_compra;
end $$;

create or replace function desfazer_compra(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_emp uuid := current_empresa_id();
  c     compras_lancadas%rowtype;
  it    jsonb;
  v_marca numeric;
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja desfaz compra.';
  end if;
  select * into c from compras_lancadas where id = p_id and empresa_id = v_emp for update;
  if not found then raise exception 'Compra não encontrada.'; end if;
  if c.status = 'desfeita' then raise exception 'Essa compra já foi desfeita.'; end if;

  for it in select * from jsonb_array_elements(c.itens) loop
    if (it->>'mov_id') is not null then
      if it->>'tipo' = 'produto' then
        delete from estoque_movimentos where id = (it->>'mov_id')::uuid and empresa_id = v_emp;
      else
        delete from materia_prima_movimentos where id = (it->>'mov_id')::uuid and empresa_id = v_emp;
      end if;
    end if;
    -- Só devolve o custo se ninguém mexeu depois: confere com o custo que ESTA compra deixou.
    -- (compras antigas não guardaram custo_depois: valia o preço pago.)
    v_marca := coalesce(nullif(it->>'custo_depois', '')::numeric, nullif((it->>'custo_unit')::numeric, 0));
    if (it->>'custo_antes') is not null and v_marca is not null then
      if it->>'tipo' = 'produto' then
        update produtos set preco_custo = (it->>'custo_antes')::numeric
         where id = (it->>'id')::uuid and empresa_id = v_emp and preco_custo = v_marca;
      else
        update materias_primas set custo = (it->>'custo_antes')::numeric
         where id = (it->>'id')::uuid and empresa_id = v_emp and custo = v_marca;
      end if;
    end if;
  end loop;

  if c.conta_id is not null then delete from contas_financeiras where id = c.conta_id and empresa_id = v_emp; end if;
  update compras_lancadas set status = 'desfeita', desfeita_em = now() where id = c.id;
end $$;
