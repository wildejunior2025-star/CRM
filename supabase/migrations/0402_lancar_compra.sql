-- 0402 — LANÇAR COMPRA: uma nota, três cantos
--
-- 26/10/2026 (pedido do AGV Grill: controle total de despesa e lucro). Até aqui a mesma
-- compra era digitada em três telas: Entrada de estoque (produtos), Estoque de matéria-prima
-- e Contas a pagar. Esta função recebe a nota inteira e grava as três coisas NA MESMA
-- TRANSAÇÃO: ou entra tudo ou não entra nada (o robô do WhatsApp faz em passos e já deixou
-- estoque entrar sem a despesa).
--
-- compras_lancadas guarda o que foi feito (ids dos movimentos, a conta e o custo que cada
-- cadastro tinha ANTES) pra DESFAZER levar os três embora juntos, inclusive o custo.
--
-- payload de lancar_compra:
--   { fornecedor, data, vencimento, pago (bool), forma, categoria, total, rateio:[{categoria,valor}],
--     itens:[{tipo:'produto'|'materia', id, nome, quantidade, custo_unit, categoria, estoque(bool)}] }
-- `estoque:false` = produto que não controla estoque: entra na conta e no registro, não no saldo.

create table if not exists compras_lancadas (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references empresas(id) on delete cascade,
  fornecedor   text not null,
  data         date not null,
  total        numeric(12,2) not null,
  pago         boolean not null default false,
  conta_id     uuid references contas_financeiras(id) on delete set null,
  itens        jsonb not null default '[]'::jsonb,   -- o que foi lançado, com mov ids e custo anterior
  status       text not null default 'lancada' check (status in ('lancada', 'desfeita')),
  criado_por   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  desfeita_em  timestamptz
);

create index if not exists idx_compras_lancadas_empresa on compras_lancadas (empresa_id, created_at desc);

alter table compras_lancadas enable row level security;
drop policy if exists compras_lancadas_admin on compras_lancadas;
create policy compras_lancadas_admin on compras_lancadas for all to authenticated
  using (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin')
  with check (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin');

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
  v_tipo    text;
  v_item    uuid;
begin
  if v_emp is null or current_perfil() <> 'admin' then
    raise exception 'Só o administrador da loja lança compra.';
  end if;
  if v_forn = '' then raise exception 'Diga de quem foi a compra (fornecedor).'; end if;
  if jsonb_typeof(p->'itens') <> 'array' or jsonb_array_length(p->'itens') = 0 then
    raise exception 'A compra está sem itens.';
  end if;
  if v_total <= 0 then raise exception 'O total da compra precisa ser maior que zero.'; end if;

  -- 1) A conta: uma por nota (a nota é UM pagamento ao MESMO fornecedor). O rateio guarda em que foi o dinheiro.
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

  -- 2) Os itens: cada um entra no estoque certo e atualiza o custo do cadastro.
  for it in select * from jsonb_array_elements(p->'itens') loop
    v_tipo  := it->>'tipo';
    v_item  := (it->>'id')::uuid;
    v_qtd   := coalesce((it->>'quantidade')::numeric, 0);
    v_custo := nullif((it->>'custo_unit')::numeric, 0);
    if v_qtd <= 0 then raise exception 'Item "%" está com quantidade zerada.', coalesce(it->>'nome', '?'); end if;
    v_valor := case when v_custo is null then null else round(v_custo * v_qtd, 2) end;
    v_id := null; v_antes := null;

    if v_tipo = 'produto' then
      if not exists (select 1 from produtos where id = v_item and empresa_id = v_emp) then
        raise exception 'Produto "%" não é desta loja.', coalesce(it->>'nome', '?');
      end if;
      select preco_custo into v_antes from produtos where id = v_item;
      if coalesce((it->>'estoque')::boolean, true) then
        insert into estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao, custo_unit, valor_total)
        values (v_emp, v_item, 'entrada', v_qtd, 'compra', 'Compra lançada — ' || v_forn, v_custo, v_valor)
        returning id into v_id;     -- null quando a loja está com o estoque desligado (gatilho ignora)
      end if;
      if v_custo is not null then update produtos set preco_custo = v_custo where id = v_item; end if;

    elsif v_tipo = 'materia' then
      if not exists (select 1 from materias_primas where id = v_item and empresa_id = v_emp) then
        raise exception 'Matéria-prima "%" não é desta loja.', coalesce(it->>'nome', '?');
      end if;
      select custo into v_antes from materias_primas where id = v_item;
      insert into materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, custo_unit, valor_total)
      values (v_emp, v_item, 'entrada', v_qtd, 'Compra lançada — ' || v_forn, v_custo, v_valor)
      returning id into v_id;
      if v_custo is not null then update materias_primas set custo = v_custo where id = v_item; end if;
    else
      raise exception 'Tipo de item inválido: %', v_tipo;
    end if;

    v_feitos := v_feitos || jsonb_build_array(it || jsonb_build_object('mov_id', v_id, 'custo_antes', v_antes));
  end loop;

  insert into compras_lancadas (id, empresa_id, fornecedor, data, total, pago, conta_id, itens)
  values (v_compra, v_emp, v_forn, v_data, v_total, v_pago, v_conta, v_feitos);

  return v_compra;
end $$;

-- DESFAZER: tira os movimentos, devolve o custo que o cadastro tinha e apaga a conta (com as baixas).
create or replace function desfazer_compra(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_emp uuid := current_empresa_id();
  c     compras_lancadas%rowtype;
  it    jsonb;
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
    -- só devolve o custo se ninguém mexeu depois: se outra compra já trocou o custo, deixa o mais novo.
    if (it->>'custo_antes') is not null and nullif((it->>'custo_unit')::numeric, 0) is not null then
      if it->>'tipo' = 'produto' then
        update produtos set preco_custo = (it->>'custo_antes')::numeric
         where id = (it->>'id')::uuid and empresa_id = v_emp and preco_custo = (it->>'custo_unit')::numeric;
      else
        update materias_primas set custo = (it->>'custo_antes')::numeric
         where id = (it->>'id')::uuid and empresa_id = v_emp and custo = (it->>'custo_unit')::numeric;
      end if;
    end if;
  end loop;

  if c.conta_id is not null then delete from contas_financeiras where id = c.conta_id and empresa_id = v_emp; end if;
  update compras_lancadas set status = 'desfeita', desfeita_em = now() where id = c.id;
end $$;

revoke all on function lancar_compra(jsonb) from public, anon;
revoke all on function desfazer_compra(uuid) from public, anon;
grant execute on function lancar_compra(jsonb) to authenticated;
grant execute on function desfazer_compra(uuid) to authenticated;
