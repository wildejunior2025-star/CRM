-- 0413 — "QUEM PEDIU?" na Cozinha: as DUAS listas de pessoas da loja
--
-- 27/10/2026: a loja tem a lista de salários (funcionarios, Despesas & Lucro) e os logins da equipe (profiles,
-- tela Funcionários). No AGV os cozinheiros estavam na de salários; no depósito do Thiago o cozinheiro novo foi
-- cadastrado como login e não aparecia. A entrega agora aceita qualquer um dos dois (profile_id novo).

alter table requisicoes_cozinha add column if not exists profile_id uuid references profiles(id) on delete set null;

create or replace function requisitar_insumos(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := current_empresa_id();
  v_hoje  date := (now() at time zone 'America/Sao_Paulo')::date;
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
  select nome into v_nome from funcionarios where id = v_func and empresa_id = v_emp;
  if v_nome is null and v_prof is not null then
    -- quem pediu tem LOGIN (tela Funcionários) e não está na lista de salários
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
  values (v_req, v_emp, v_func, v_prof, v_nome, v_hoje, v_obs, auth.uid());

  for it in select * from jsonb_array_elements(p->'itens') loop
    v_qtd := coalesce((it->>'quantidade')::numeric, 0);
    select id, nome, unidade, custo into m from materias_primas
     where id = (it->>'id')::uuid and empresa_id = v_emp;
    if m.id is null then raise exception 'Insumo não é desta loja.'; end if;
    if v_qtd <= 0 then raise exception 'Item "%" está com quantidade zerada.', m.nome; end if;
    v_valor := case when coalesce(m.custo, 0) > 0 then round(m.custo * v_qtd, 2) end;

    insert into materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, custo_unit, valor_total, created_by)
    values (v_emp, m.id, 'saida', v_qtd, 'Cozinha — ' || v_nome, nullif(m.custo, 0), v_valor, auth.uid())
    returning id into v_mov;

    insert into requisicao_itens (requisicao_id, empresa_id, materia_prima_id, nome, unidade, quantidade, custo_unit, valor, mov_saida_id)
    values (v_req, v_emp, m.id, m.nome, m.unidade, v_qtd, nullif(m.custo, 0), v_valor, v_mov);
    v_total := v_total + coalesce(v_valor, 0);
  end loop;

  update requisicoes_cozinha set valor_total = round(v_total, 2) where id = v_req;
  return v_req;
end $$;
