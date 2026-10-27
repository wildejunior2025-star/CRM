-- 0409 — REQUISIÇÃO DA COZINHA (almoxarifado → cozinha) + SOBRA DO DIA
--
-- 27/10/2026, pedido do AGV Grill: o estoque (sala reservada) entrega insumo pra cozinha todo dia
-- ("10 kg de frango, 2 de tomate…") e hoje não há registro de quem pegou. O dono faz tudo sozinho, pelo
-- celular, e no fim do dia o cozinheiro traz os pesos do que sobrou.
--
-- Modelo SIMPLES, sem 2º estoque:
--   entrega  = SAÍDA de matéria-prima (valorizada no custo médio do momento), com quem pediu;
--   sobra    = ENTRADA de volta, no mesmo custo da entrega;
--   consumo real do dia = entregue − voltou.
-- Tudo passa pelos movimentos de estoque que já existem (materia_prima_movimentos), então o saldo, o
-- "valor parado" e o histórico continuam batendo sem mexer em nada.
-- Quem pediu vem do cadastro de Funcionários (funcionarios) — o cozinheiro não precisa de login.

create table if not exists requisicoes_cozinha (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references empresas(id) on delete cascade,
  funcionario_id   uuid references funcionarios(id) on delete set null,
  funcionario_nome text not null,
  data             date not null,
  valor_total      numeric(12,2) not null default 0,   -- o que saiu do estoque (entregue)
  valor_usado      numeric(12,2),                      -- entregue − voltou; null enquanto a sobra não foi registrada
  observacao       text,
  status           text not null default 'aberta' check (status in ('aberta', 'fechada')),
  created_at       timestamptz not null default now(),
  created_by       uuid,
  fechada_em       timestamptz,
  fechada_por      uuid
);
create index if not exists idx_req_cozinha_dia on requisicoes_cozinha (empresa_id, data desc);

create table if not exists requisicao_itens (
  id               uuid primary key default gen_random_uuid(),
  requisicao_id    uuid not null references requisicoes_cozinha(id) on delete cascade,
  empresa_id       uuid not null references empresas(id) on delete cascade,
  materia_prima_id uuid references materias_primas(id) on delete set null,
  nome             text not null,
  unidade          text not null,
  quantidade       numeric(14,4) not null check (quantidade > 0),
  custo_unit       numeric(14,4),
  valor            numeric(12,2),
  voltou           numeric(14,4) not null default 0,
  mov_saida_id     uuid,
  mov_volta_id     uuid
);
create index if not exists idx_req_itens_req on requisicao_itens (requisicao_id);

alter table requisicoes_cozinha enable row level security;
alter table requisicao_itens enable row level security;

drop policy if exists req_cozinha_admin on requisicoes_cozinha;
create policy req_cozinha_admin on requisicoes_cozinha for all
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

drop policy if exists req_itens_admin on requisicao_itens;
create policy req_itens_admin on requisicao_itens for all
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

-- ── Entregar à cozinha ───────────────────────────────────────────────────────
-- p = { funcionario_id, observacao?, itens: [{ id: <materia_prima_id>, quantidade }] }
create or replace function requisitar_insumos(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := current_empresa_id();
  v_hoje  date := (now() at time zone 'America/Sao_Paulo')::date;
  v_func  uuid := nullif(p->>'funcionario_id', '')::uuid;
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
  if v_nome is null then raise exception 'Escolha quem pediu (funcionário da loja).'; end if;
  if jsonb_typeof(p->'itens') <> 'array' or jsonb_array_length(p->'itens') = 0 then
    raise exception 'A entrega está sem itens.';
  end if;

  insert into requisicoes_cozinha (id, empresa_id, funcionario_id, funcionario_nome, data, observacao, created_by)
  values (v_req, v_emp, v_func, v_nome, v_hoje, v_obs, auth.uid());

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

-- ── Sobra do dia ─────────────────────────────────────────────────────────────
-- p = { itens: [{ id: <requisicao_itens.id>, voltou }] }. Pode ser refeita: desfaz o retorno anterior e aplica o novo.
create or replace function registrar_sobra(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := current_empresa_id();
  r       requisicoes_cozinha%rowtype;
  it      record;
  v_vol   numeric;
  v_mov   uuid;
  v_usado numeric := 0;
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja registra a sobra.';
  end if;
  select * into r from requisicoes_cozinha where id = p_id and empresa_id = v_emp;
  if r.id is null then raise exception 'Entrega não encontrada.'; end if;

  -- desfaz o retorno anterior (se houver)
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
      insert into materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, custo_unit, valor_total, created_by)
      values (v_emp, it.materia_prima_id, 'entrada', v_vol, 'Sobra da cozinha — ' || r.funcionario_nome, it.custo_unit,
              case when it.custo_unit is null then null else round(it.custo_unit * v_vol, 2) end, auth.uid())
      returning id into v_mov;
    end if;
    update requisicao_itens set voltou = v_vol, mov_volta_id = v_mov where id = it.id;
    v_usado := v_usado + coalesce(it.custo_unit, 0) * (it.quantidade - v_vol);
  end loop;

  update requisicoes_cozinha set status = 'fechada', valor_usado = round(v_usado, 2), fechada_em = now(), fechada_por = auth.uid()
   where id = p_id;
end $$;

-- ── Desfazer a entrega (digitou errado) ──────────────────────────────────────
create or replace function desfazer_requisicao(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_emp uuid := current_empresa_id();
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja desfaz entrega.';
  end if;
  if not exists (select 1 from requisicoes_cozinha where id = p_id and empresa_id = v_emp) then
    raise exception 'Entrega não encontrada.';
  end if;
  delete from materia_prima_movimentos
   where id in (select mov_saida_id from requisicao_itens where requisicao_id = p_id and mov_saida_id is not null)
      or id in (select mov_volta_id from requisicao_itens where requisicao_id = p_id and mov_volta_id is not null);
  delete from requisicoes_cozinha where id = p_id;   -- os itens vão junto (cascade)
end $$;

revoke all on function requisitar_insumos(jsonb), registrar_sobra(uuid, jsonb), desfazer_requisicao(uuid) from public, anon;
grant execute on function requisitar_insumos(jsonb), registrar_sobra(uuid, jsonb), desfazer_requisicao(uuid) to authenticated;
