-- 0459 — Cozinha: escolher o DIA da entrega (AGV, 19/11/2026)
--
-- A Victoria (AGV) recebeu proteina ontem e so lembrou de lancar hoje: o sistema gravava tudo no dia de hoje e o
-- "Ontem" ficava errado. Agora a entrega aceita p->>'data' (hoje, ou ate 30 dias atras, nunca no futuro). A
-- requisicao E os movimentos de estoque (saida e, depois, a sobra) caem no dia escolhido, entao Entrou e saiu,
-- Conferencia do mes e o gasto real x previsto batem com o dia em que a comida realmente saiu.

create or replace function requisitar_insumos(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := current_empresa_id();
  v_hoje  date := (now() at time zone 'America/Sao_Paulo')::date;
  v_data  date := coalesce(nullif(p->>'data', '')::date, (now() at time zone 'America/Sao_Paulo')::date);
  v_quando timestamptz;
  v_func  uuid := nullif(p->>'funcionario_id', '')::uuid;
  v_prof  uuid := nullif(p->>'profile_id', '')::uuid;
  v_nome  text;
  v_obs   text := nullif(btrim(coalesce(p->>'observacao', '')), '');
  v_req   uuid := gen_random_uuid();
  it      jsonb;
  m       record;
  v_qtd   numeric;
  v_valor numeric;
  v_total numeric := 0;
  v_mov   uuid;
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja entrega insumo pra cozinha.';
  end if;
  if v_data > v_hoje then raise exception 'A data da entrega não pode ser no futuro.'; end if;
  if v_data < v_hoje - 30 then raise exception 'A data da entrega é antiga demais (máximo 30 dias).'; end if;
  -- Dia passado: a saída cai ao meio-dia desse dia. Hoje: agora.
  v_quando := case when v_data = v_hoje then now() else ((v_data::text || ' 12:00:00-03')::timestamptz) end;

  select nome into v_nome from funcionarios where id = v_func and empresa_id = v_emp;
  if v_nome is null and v_prof is not null then
    select coalesce(nullif(btrim(nome), ''), email) into v_nome from profiles where id = v_prof and empresa_id = v_emp;
    v_func := null;
  else
    v_prof := null;
  end if;
  if v_nome is null then raise exception 'Escolha quem pediu (funcionário da loja).'; end if;
  if jsonb_typeof(p->'itens') <> 'array' or jsonb_array_length(p->'itens') = 0 then
    raise exception 'A entrega está sem itens.';
  end if;

  insert into requisicoes_cozinha (id, empresa_id, funcionario_id, profile_id, funcionario_nome, data, observacao, created_by)
  values (v_req, v_emp, v_func, v_prof, v_nome, v_data, v_obs, auth.uid());

  for it in select * from jsonb_array_elements(p->'itens') loop
    v_qtd := coalesce((it->>'quantidade')::numeric, 0);
    select id, nome, unidade, custo into m from materias_primas
     where id = (it->>'id')::uuid and empresa_id = v_emp;
    if m.id is null then raise exception 'Insumo não é desta loja.'; end if;
    if v_qtd <= 0 then raise exception 'Item "%" está com quantidade zerada.', m.nome; end if;
    v_valor := case when coalesce(m.custo, 0) > 0 then round(m.custo * v_qtd, 2) end;

    insert into materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, custo_unit, valor_total, created_by, created_at)
    values (v_emp, m.id, 'saida', v_qtd, 'Cozinha — ' || v_nome, nullif(m.custo, 0), v_valor, auth.uid(), v_quando)
    returning id into v_mov;

    insert into requisicao_itens (requisicao_id, empresa_id, materia_prima_id, nome, unidade, quantidade, custo_unit, valor, mov_saida_id)
    values (v_req, v_emp, m.id, m.nome, m.unidade, v_qtd, nullif(m.custo, 0), v_valor, v_mov);
    v_total := v_total + coalesce(v_valor, 0);
  end loop;

  update requisicoes_cozinha set valor_total = round(v_total, 2) where id = v_req;
  return v_req;
end $$;

-- A sobra volta no dia da entrega (entrega de ontem registrada hoje: a sobra entra no estoque de ontem, 23h).
create or replace function registrar_sobra(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := current_empresa_id();
  v_hoje  date := (now() at time zone 'America/Sao_Paulo')::date;
  r       requisicoes_cozinha%rowtype;
  it      record;
  v_vol   numeric;
  v_mov   uuid;
  v_usado numeric := 0;
  v_quando timestamptz;
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja registra a sobra.';
  end if;
  select * into r from requisicoes_cozinha where id = p_id and empresa_id = v_emp;
  if r.id is null then raise exception 'Entrega não encontrada.'; end if;
  v_quando := case when r.data >= v_hoje then now() else ((r.data::text || ' 23:00:00-03')::timestamptz) end;

  delete from materia_prima_movimentos where id in (select mov_volta_id from requisicao_itens where requisicao_id = p_id and mov_volta_id is not null);
  update requisicao_itens set voltou = 0, mov_volta_id = null where requisicao_id = p_id;

  for it in select * from requisicao_itens where requisicao_id = p_id loop
    select coalesce((x->>'voltou')::numeric, 0) into v_vol
      from jsonb_array_elements(coalesce(p->'itens', '[]'::jsonb)) x where (x->>'id')::uuid = it.id;
    v_vol := coalesce(v_vol, 0);
    if v_vol < 0 then raise exception 'Sobra negativa em "%".', it.nome; end if;
    if v_vol > it.quantidade then
      raise exception '"%": voltou % mas só foi entregue %.', it.nome, v_vol, it.quantidade;
    end if;
    v_mov := null;
    if v_vol > 0 and it.materia_prima_id is not null then
      insert into materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, custo_unit, valor_total, created_by, created_at)
      values (v_emp, it.materia_prima_id, 'entrada', v_vol, 'Sobra da cozinha — ' || r.funcionario_nome, it.custo_unit,
              case when it.custo_unit is null then null else round(it.custo_unit * v_vol, 2) end, auth.uid(), v_quando)
      returning id into v_mov;
    end if;
    update requisicao_itens set voltou = v_vol, mov_volta_id = v_mov where id = it.id;
    v_usado := v_usado + coalesce(it.custo_unit, 0) * (it.quantidade - v_vol);
  end loop;

  update requisicoes_cozinha set status = 'fechada', valor_usado = round(v_usado, 2), fechada_em = now(), fechada_por = auth.uid()
   where id = p_id;
end $$;

revoke all on function requisitar_insumos(jsonb), registrar_sobra(uuid, jsonb) from public, anon;
grant execute on function requisitar_insumos(jsonb), registrar_sobra(uuid, jsonb) to authenticated;
