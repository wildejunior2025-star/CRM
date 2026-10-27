-- 0416 — CONTAGEM DE ESTOQUE: o dono conta tudo pelo celular e o sistema acerta o saldo de uma vez
--
-- 27/10/2026, AGV Grill: a Conferência do mês (0410) só fecha se o estoque do início e do fim forem CONTADOS.
-- O dono vai contar no dia 1º, antes de abrir. Regras:
--   * grava só a DIFERENÇA (contado − saldo do sistema) como 'ajuste', igual ao "Acertar" da Ficha Técnica;
--   * o ajuste é datado no COMEÇO DO DIA da contagem (meia-noite − 1 s). Assim a contagem do dia 1º vira o
--     estoque do FIM do mês anterior e do INÍCIO do mês novo. A conta continua certa se algo já mexeu hoje:
--     contado agora = início do dia + movimentos de hoje  →  início do dia = contado − movimentos de hoje,
--     que é exatamente o saldo que fica no começo do dia com a diferença gravada lá;
--   * item em branco não é contado nem mexido (dá pra contar insumo hoje e bebida amanhã);
--   * só a ÚLTIMA contagem pode ser desfeita (desfazer uma antiga estragaria a conta das seguintes);
--   * ajuste não manda WhatsApp (estoque_mov_avisavel ignora), mas marcamos avisado_em por garantia.

create table if not exists contagens_estoque (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null default current_empresa_id() references empresas(id) on delete cascade,
  referencia      timestamptz not null,               -- o momento que a contagem representa (começo do dia − 1 s)
  feita_em        timestamptz not null default now(),
  feita_por       uuid default auth.uid(),
  feita_por_nome  text,
  itens           int not null default 0,             -- quantos itens foram contados
  itens_diferentes int not null default 0,            -- quantos estavam diferentes do sistema
  valor_contado   numeric not null default 0,         -- quanto vale o que foi contado (custo atual)
  valor_diferenca numeric not null default 0          -- contado − sistema, em R$ (negativo = faltou)
);
create index if not exists contagens_estoque_emp_ref on contagens_estoque (empresa_id, referencia desc);

alter table contagens_estoque enable row level security;
drop policy if exists contagens_estoque_admin on contagens_estoque;
create policy contagens_estoque_admin on contagens_estoque for select to authenticated
  using (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin');

alter table materia_prima_movimentos add column if not exists contagem_id uuid references contagens_estoque(id) on delete set null;
alter table estoque_movimentos        add column if not exists contagem_id uuid references contagens_estoque(id) on delete set null;

-- p = { itens: [ { tipo: 'mp'|'prod', id, contado } ] }
create or replace function registrar_contagem(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := current_empresa_id();
  v_ref   timestamptz := (date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo') - interval '1 second';
  v_nome  text;
  v_id    uuid;
  it      jsonb;
  v_item  uuid;
  v_cont  numeric;
  v_saldo numeric;
  v_custo numeric;
  v_dif   numeric;
  n       int := 0;
  n_dif   int := 0;
  v_val   numeric := 0;
  v_vdif  numeric := 0;
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja faz a contagem.';
  end if;
  if jsonb_array_length(coalesce(p->'itens', '[]')) = 0 then
    raise exception 'Nenhum item contado.';
  end if;

  select coalesce(nullif(trim(nome), ''), email) into v_nome from profiles where id = auth.uid();
  insert into contagens_estoque (empresa_id, referencia, feita_por_nome)
       values (v_emp, v_ref, v_nome) returning id into v_id;

  for it in select * from jsonb_array_elements(p->'itens') loop
    v_item := (it->>'id')::uuid;
    v_cont := (it->>'contado')::numeric;
    if v_cont is null or v_cont < 0 then raise exception 'Quantidade contada inválida.'; end if;

    if it->>'tipo' = 'mp' then
      select m.custo into v_custo from materias_primas m where m.id = v_item and m.empresa_id = v_emp;
      if not found then raise exception 'Insumo não encontrado.'; end if;
      select coalesce(sum(case tipo when 'entrada' then quantidade when 'saida' then -quantidade when 'ajuste' then quantidade else 0 end), 0)
        into v_saldo from materia_prima_movimentos where materia_prima_id = v_item;
      v_dif := v_cont - v_saldo;
      if v_dif <> 0 then
        insert into materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, created_at, created_by, avisado_em, contagem_id)
             values (v_emp, v_item, 'ajuste', v_dif, 'Contagem de estoque — ' || coalesce(v_nome, 'dono'), v_ref, auth.uid(), now(), v_id);
      end if;
    elsif it->>'tipo' = 'prod' then
      select p2.preco_custo into v_custo from produtos p2 where p2.id = v_item and p2.empresa_id = v_emp;
      if not found then raise exception 'Produto não encontrado.'; end if;
      v_saldo := estoque_saldo_produto(v_item);
      v_dif := v_cont - v_saldo;
      if v_dif <> 0 then
        insert into estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao, created_at, created_by, avisado_em, contagem_id)
             values (v_emp, v_item, 'ajuste', v_dif, 'contagem', 'Contagem de estoque — ' || coalesce(v_nome, 'dono'), v_ref, auth.uid(), now(), v_id);
      end if;
    else
      raise exception 'Tipo de item inválido.';
    end if;

    n := n + 1;
    if v_dif <> 0 then n_dif := n_dif + 1; end if;
    v_val  := v_val  + v_cont * coalesce(v_custo, 0);
    v_vdif := v_vdif + v_dif  * coalesce(v_custo, 0);
  end loop;

  update contagens_estoque
     set itens = n, itens_diferentes = n_dif, valor_contado = round(v_val, 2), valor_diferenca = round(v_vdif, 2)
   where id = v_id;

  return jsonb_build_object('id', v_id, 'itens', n, 'itens_diferentes', n_dif,
                            'valor_contado', round(v_val, 2), 'valor_diferenca', round(v_vdif, 2));
end $$;

create or replace function desfazer_contagem(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_emp uuid := current_empresa_id();
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja desfaz a contagem.';
  end if;
  if not exists (select 1 from contagens_estoque where id = p_id and empresa_id = v_emp) then
    raise exception 'Contagem não encontrada.';
  end if;
  if exists (select 1 from contagens_estoque where empresa_id = v_emp and feita_em > (select feita_em from contagens_estoque where id = p_id)) then
    raise exception 'Só dá pra desfazer a última contagem.';
  end if;
  delete from materia_prima_movimentos where contagem_id = p_id and empresa_id = v_emp;
  delete from estoque_movimentos where contagem_id = p_id and empresa_id = v_emp;
  delete from contagens_estoque where id = p_id;
end $$;

revoke all on function registrar_contagem(jsonb) from public, anon;
revoke all on function desfazer_contagem(uuid) from public, anon;
grant execute on function registrar_contagem(jsonb) to authenticated;
grant execute on function desfazer_contagem(uuid) to authenticated;

-- Conferência: diz se o mês começou e terminou com estoque CONTADO (e não só o do sistema).
create or replace function conferencia_mes(p_ini date, p_fim date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_emp   uuid := current_empresa_id();
  v_ini   timestamptz := (p_ini::timestamp) at time zone 'America/Sao_Paulo';
  v_fim   timestamptz := ((p_fim + 1)::timestamp) at time zone 'America/Sao_Paulo';
  r       jsonb;
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja vê a conferência.';
  end if;

  with sinal as (
    select materia_prima_id as item, created_at,
           case tipo when 'entrada' then quantidade when 'saida' then -quantidade when 'ajuste' then quantidade else 0 end as q
      from materia_prima_movimentos where empresa_id = v_emp
  ), ins as (
    select coalesce(sum(s.q) filter (where s.created_at < v_ini) * m.custo, 0) as ini,
           coalesce(sum(s.q) filter (where s.created_at < v_fim) * m.custo, 0) as fim
      from materias_primas m left join sinal s on s.item = m.id
     where m.empresa_id = v_emp group by m.id, m.custo
  ), sinal_p as (
    select produto_id as item, created_at,
           case tipo when 'entrada' then quantidade when 'saida' then -quantidade when 'ajuste' then quantidade else 0 end as q
      from estoque_movimentos where empresa_id = v_emp
  ), prod as (
    select coalesce(sum(s.q) filter (where s.created_at < v_ini) * p.preco_custo, 0) as ini,
           coalesce(sum(s.q) filter (where s.created_at < v_fim) * p.preco_custo, 0) as fim
      from produtos p join sinal_p s on s.item = p.id
     where p.empresa_id = v_emp and coalesce(p.controla_estoque, true) group by p.id, p.preco_custo
  )
  select jsonb_build_object(
    'insumos_ini', round((select coalesce(sum(ini), 0) from ins), 2),
    'insumos_fim', round((select coalesce(sum(fim), 0) from ins), 2),
    'produtos_ini', round((select coalesce(sum(ini), 0) from prod), 2),
    'produtos_fim', round((select coalesce(sum(fim), 0) from prod), 2),
    'compras_insumos', round((select coalesce(sum(coalesce(valor_total, quantidade * custo_unit, 0)), 0)
        from materia_prima_movimentos where empresa_id = v_emp and tipo = 'entrada'
         and created_at >= v_ini and created_at < v_fim and coalesce(observacao, '') not like 'Sobra da cozinha%'), 2),
    'compras_produtos', round((select coalesce(sum(coalesce(valor_total, quantidade * custo_unit, 0)), 0)
        from estoque_movimentos where empresa_id = v_emp and tipo = 'entrada' and motivo = 'compra'
         and created_at >= v_ini and created_at < v_fim), 2),
    'previsto_pratos', round((select coalesce(sum(custo), 0) from custo_vendido_periodo(v_ini, v_fim, v_emp)), 2),
    'vendido_pratos', round((select coalesce(sum(valor_vendido), 0) from custo_vendido_periodo(v_ini, v_fim, v_emp)), 2),
    'previsto_revenda', round((select coalesce(sum(m.quantidade * coalesce(p.preco_custo, 0)), 0)
        from estoque_movimentos m join produtos p on p.id = m.produto_id
       where m.empresa_id = v_emp and m.tipo = 'saida' and m.motivo = 'venda'
         and m.created_at >= v_ini and m.created_at < v_fim), 2),
    'cozinha_entregue', round((select coalesce(sum(valor_total), 0) from requisicoes_cozinha where empresa_id = v_emp and data between p_ini and p_fim), 2),
    'cozinha_usado', round((select coalesce(sum(valor_usado), 0) from requisicoes_cozinha where empresa_id = v_emp and data between p_ini and p_fim and status = 'fechada'), 2),
    'cozinha_sem_sobra', (select count(*) from requisicoes_cozinha where empresa_id = v_emp and data between p_ini and p_fim and status = 'aberta'),
    'produtos_sem_custo', (select count(*) from produtos p where p.empresa_id = v_emp and coalesce(p.controla_estoque, true)
        and coalesce(p.preco_custo, 0) = 0 and exists (select 1 from estoque_movimentos e where e.produto_id = p.id)),
    'insumos_sem_custo', (select count(*) from materias_primas m where m.empresa_id = v_emp and coalesce(m.custo, 0) = 0
        and exists (select 1 from materia_prima_movimentos e where e.materia_prima_id = m.id)),
    -- já houve contagem ANTES do mês começar? (a do dia 1º de manhã conta: fica datada no fim do mês anterior)
    'contou_inicio', exists (select 1 from contagens_estoque where empresa_id = v_emp and referencia < v_ini),
    -- contou nos últimos dias do mês (ou no dia 1º seguinte, que fica datado no último dia)?
    'contou_fim', exists (select 1 from contagens_estoque where empresa_id = v_emp
        and referencia >= v_fim - interval '4 days' and referencia < v_fim)
  ) into r;
  return r;
end $$;

revoke all on function conferencia_mes(date, date) from public, anon;
grant execute on function conferencia_mes(date, date) to authenticated;
