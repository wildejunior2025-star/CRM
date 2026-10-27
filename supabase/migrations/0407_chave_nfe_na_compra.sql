-- 0407 — A CHAVE DA NOTA FISCAL NA COMPRA
--
-- 27/10/2026: o dono entra com a nota digitando/bipando a chave de 44 dígitos (ou foto). Dois usos:
--  * compras_lancadas.chave_nfe: a MESMA nota não entra duas vezes (índice único entre as compras
--    ativas; corrigir_compra desfaz a antiga antes de lançar a nova, então não conflita);
--  * fornecedores.cnpj: a chave traz o CNPJ do emitente, então da 2ª nota em diante o fornecedor é
--    reconhecido sozinho.

alter table fornecedores add column if not exists cnpj text;
create index if not exists idx_fornecedores_cnpj on fornecedores (empresa_id, cnpj) where cnpj is not null;

alter table compras_lancadas add column if not exists chave_nfe text;
create unique index if not exists uq_compras_chave_ativa on compras_lancadas (empresa_id, chave_nfe)
  where chave_nfe is not null and status = 'lancada';

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
  v_nota    text := btrim(coalesce(p->>'numero_nota', ''));
  v_obs     text := nullif(btrim(coalesce(p->>'observacao', '')), '');
  v_chave   text := case when length(regexp_replace(coalesce(p->>'chave_nfe', ''), '\D', '', 'g')) = 44 then regexp_replace(p->>'chave_nfe', '\D', '', 'g') end;
  v_desc    text;
  v_cat     text := coalesce(nullif(p->>'categoria', ''), 'Fornecedores');
  v_rateio  jsonb := case when jsonb_typeof(p->'rateio') = 'array' and jsonb_array_length(p->'rateio') > 0 then p->'rateio' end;
  v_compra  uuid := gen_random_uuid();
  v_conta   uuid;
  v_contas  uuid[] := '{}';
  v_grupo   uuid;
  v_np      int;
  par       jsonb;
  v_i       int;
  v_pv      numeric;
  v_soma    numeric;
  v_rat     jsonb;
  v_quando  timestamptz;
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

  v_desc := 'Compra — ' || v_forn || case when v_nota <> '' then ' (NF ' || v_nota || ')' else '' end;
  -- Compra de dias atrás entra no estoque NAQUELE dia (meio-dia); a de hoje, na hora de agora.
  v_quando := case when v_data < v_hoje then ((v_data::timestamp + interval '12 hours') at time zone 'America/Sao_Paulo') else now() end;

  -- 1) A conta. Parcelado = uma conta por parcela, mesmo grupo, rateio dividido na mesma proporção.
  v_np := case when not v_pago and jsonb_typeof(p->'parcelas') = 'array' then jsonb_array_length(p->'parcelas') else 0 end;
  if v_np > 1 then
    select coalesce(sum(round((x->>'valor')::numeric, 2)), 0) into v_soma from jsonb_array_elements(p->'parcelas') x;
    if abs(v_soma - v_total) > 0.02 then
      raise exception 'As parcelas somam % e a compra é de %.', v_soma, v_total;
    end if;
    v_grupo := gen_random_uuid();
    v_i := 0;
    for par in select * from jsonb_array_elements(p->'parcelas') loop
      v_i := v_i + 1;
      v_pv := round((par->>'valor')::numeric, 2);
      if v_pv <= 0 then raise exception 'A parcela % está com valor zerado.', v_i; end if;
      v_rat := null;
      if v_rateio is not null then
        select jsonb_agg(jsonb_build_object('categoria', r->>'categoria', 'valor', round((r->>'valor')::numeric * v_pv / v_total, 2)))
          into v_rat from jsonb_array_elements(v_rateio) r;
        -- a sobra do arredondamento vai pra primeira categoria, pro rateio fechar com a parcela
        v_rat := jsonb_set(v_rat, '{0,valor}', to_jsonb(round(
          (v_rat->0->>'valor')::numeric + (v_pv - (select coalesce(sum((x->>'valor')::numeric), 0) from jsonb_array_elements(v_rat) x)), 2)));
      end if;
      insert into contas_financeiras (empresa_id, tipo, descricao, pessoa, categoria, valor, vencimento, rateio,
                                      observacao, recorrencia, grupo_id, parcela, parcelas, origem)
      values (v_emp, 'pagar', v_desc || ' ' || v_i || '/' || v_np, v_forn, v_cat, v_pv, (par->>'vencimento')::date, v_rat,
              v_obs, 'nenhuma', v_grupo, v_i, v_np, 'portal')
      returning id into v_conta;
      v_contas := v_contas || v_conta;
    end loop;
    v_conta := v_contas[1];
  else
    insert into contas_financeiras (empresa_id, tipo, descricao, pessoa, categoria, valor, vencimento, rateio, observacao, recorrencia, origem)
    values (v_emp, 'pagar', v_desc, v_forn, v_cat, v_total, case when v_pago then v_data else v_venc end, v_rateio, v_obs, 'nenhuma', 'portal')
    returning id into v_conta;
    v_contas := array[v_conta];
    if v_pago then
      insert into contas_baixas (empresa_id, conta_id, valor, data, forma, origem)
      values (v_emp, v_conta, v_total, v_data, nullif(p->>'forma', ''), 'portal');
    end if;
  end if;

  -- 2) Os itens: cada um entra no estoque certo; o custo do cadastro vira a MÉDIA ponderada (0405).
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
        select coalesce(sum(case when tipo = 'entrada' then quantidade when tipo = 'saida' then -quantidade
                                 when tipo = 'ajuste' then quantidade else 0 end), 0)
          into v_saldo from estoque_movimentos where produto_id = v_item;
        insert into estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao, custo_unit, valor_total, created_at)
        values (v_emp, v_item, 'entrada', v_qtd, 'compra', 'Compra lançada — ' || v_forn, v_custo, v_valor, v_quando)
        returning id into v_id;
      end if;
      if v_custo is not null then
        v_depois := case when v_ctrl and v_id is not null and v_saldo > 0 and coalesce(v_antes, 0) > 0
                         then round((v_saldo * v_antes + v_qtd * v_custo) / (v_saldo + v_qtd), 4)
                         else v_custo end;
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
      insert into materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, custo_unit, valor_total, created_at)
      values (v_emp, v_item, 'entrada', v_qtd, 'Compra lançada — ' || v_forn, v_custo, v_valor, v_quando)
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

  insert into compras_lancadas (id, empresa_id, fornecedor, data, total, pago, conta_id, conta_ids, itens, numero_nota, observacao, payload, chave_nfe)
  values (v_compra, v_emp, v_forn, v_data, v_total, v_pago, v_conta, v_contas, v_feitos, nullif(v_nota, ''), v_obs, p, v_chave);

  return v_compra;
end $$;

