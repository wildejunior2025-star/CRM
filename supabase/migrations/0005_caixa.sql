-- =========================================================
-- CRM Depósito de Bebidas - Migration 0005
-- Módulo: Caixa (abertura/fechamento de turno, sangrias e suprimentos)
-- =========================================================

-- ---------------------------------------------------------
-- CAIXAS
-- ---------------------------------------------------------
create table if not exists caixas (
  id uuid primary key default gen_random_uuid(),
  aberto_por uuid not null references auth.users(id),
  aberto_em timestamptz not null default now(),
  valor_abertura numeric(12,2) not null default 0,
  observacoes_abertura text,
  fechado_em timestamptz,
  valor_fechamento_informado numeric(12,2),
  observacoes_fechamento text,
  status text not null default 'aberto' check (status in ('aberto', 'fechado')),
  created_at timestamptz not null default now()
);

create index if not exists idx_caixas_aberto_por on caixas(aberto_por);
create unique index if not exists idx_caixas_um_aberto_por_usuario
  on caixas(aberto_por) where status = 'aberto';

-- ---------------------------------------------------------
-- CAIXA_MOVIMENTOS (sangrias e suprimentos)
-- ---------------------------------------------------------
create table if not exists caixa_movimentos (
  id uuid primary key default gen_random_uuid(),
  caixa_id uuid not null references caixas(id) on delete cascade,
  tipo text not null check (tipo in ('sangria', 'suprimento')),
  valor numeric(12,2) not null check (valor > 0),
  observacao text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_caixa_movimentos_caixa on caixa_movimentos(caixa_id);

-- ---------------------------------------------------------
-- Vincula vendas/pagamentos ao caixa aberto no momento do registro
-- ---------------------------------------------------------
alter table vendas add column if not exists caixa_id uuid references caixas(id);
alter table pagamentos add column if not exists caixa_id uuid references caixas(id);

create or replace function current_caixa_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select id from caixas where aberto_por = auth.uid() and status = 'aberto' limit 1;
$$;

alter table vendas alter column caixa_id set default current_caixa_id();
alter table pagamentos alter column caixa_id set default current_caixa_id();

grant execute on function current_caixa_id() to authenticated;
revoke execute on function current_caixa_id() from anon;

-- ---------------------------------------------------------
-- RLS - caixas / caixa_movimentos
-- (admin vê e gerencia tudo; vendedor vê/gerencia apenas os próprios)
-- ---------------------------------------------------------
alter table caixas enable row level security;
alter table caixa_movimentos enable row level security;

create policy "Usuario ve os proprios caixas ou admin ve todos"
  on caixas for select
  using (current_perfil() = 'admin' or aberto_por = auth.uid());

create policy "Admin gerencia caixas"
  on caixas for all
  using (current_perfil() = 'admin')
  with check (current_perfil() = 'admin');

create policy "Usuario ve os proprios movimentos de caixa ou admin ve todos"
  on caixa_movimentos for select
  using (
    current_perfil() = 'admin'
    or exists (
      select 1 from caixas c
      where c.id = caixa_movimentos.caixa_id
        and c.aberto_por = auth.uid()
    )
  );

create policy "Admin gerencia movimentos de caixa"
  on caixa_movimentos for all
  using (current_perfil() = 'admin')
  with check (current_perfil() = 'admin');

-- ---------------------------------------------------------
-- abrir_caixa: abre um novo caixa para o usuário atual
-- ---------------------------------------------------------
create or replace function abrir_caixa(p_valor_abertura numeric, p_observacoes text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para abrir caixa';
  end if;

  if exists (select 1 from caixas where aberto_por = auth.uid() and status = 'aberto') then
    raise exception 'Você já tem um caixa aberto';
  end if;

  if p_valor_abertura < 0 then
    raise exception 'Valor de abertura inválido';
  end if;

  insert into caixas (aberto_por, valor_abertura, observacoes_abertura)
  values (auth.uid(), p_valor_abertura, p_observacoes)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------
-- registrar_movimento_caixa: sangria ou suprimento no caixa aberto
-- ---------------------------------------------------------
create or replace function registrar_movimento_caixa(
  p_caixa_id uuid,
  p_tipo text,
  p_valor numeric,
  p_observacao text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caixa caixas%rowtype;
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para movimentar caixa';
  end if;

  if p_tipo not in ('sangria', 'suprimento') then
    raise exception 'Tipo de movimento inválido';
  end if;

  if p_valor <= 0 then
    raise exception 'Valor inválido';
  end if;

  select * into v_caixa from caixas where id = p_caixa_id;

  if v_caixa is null or v_caixa.status <> 'aberto' then
    raise exception 'Caixa não está aberto';
  end if;

  if v_caixa.aberto_por <> auth.uid() and current_perfil() <> 'admin' then
    raise exception 'Sem permissão para movimentar este caixa';
  end if;

  insert into caixa_movimentos (caixa_id, tipo, valor, observacao, created_by)
  values (p_caixa_id, p_tipo, p_valor, p_observacao, auth.uid());
end;
$$;

-- ---------------------------------------------------------
-- fechar_caixa: fecha o caixa registrando o valor contado
-- ---------------------------------------------------------
create or replace function fechar_caixa(
  p_caixa_id uuid,
  p_valor_fechamento numeric,
  p_observacoes text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caixa caixas%rowtype;
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para fechar caixa';
  end if;

  select * into v_caixa from caixas where id = p_caixa_id;

  if v_caixa is null then
    raise exception 'Caixa não encontrado';
  end if;

  if v_caixa.status <> 'aberto' then
    raise exception 'Caixa já está fechado';
  end if;

  if v_caixa.aberto_por <> auth.uid() and current_perfil() <> 'admin' then
    raise exception 'Sem permissão para fechar este caixa';
  end if;

  if p_valor_fechamento < 0 then
    raise exception 'Valor de fechamento inválido';
  end if;

  update caixas
  set status = 'fechado',
      fechado_em = now(),
      valor_fechamento_informado = p_valor_fechamento,
      observacoes_fechamento = p_observacoes
  where id = p_caixa_id;
end;
$$;

grant execute on function abrir_caixa(numeric, text) to authenticated;
grant execute on function registrar_movimento_caixa(uuid, text, numeric, text) to authenticated;
grant execute on function fechar_caixa(uuid, numeric, text) to authenticated;

revoke execute on function abrir_caixa(numeric, text) from anon;
revoke execute on function registrar_movimento_caixa(uuid, text, numeric, text) from anon;
revoke execute on function fechar_caixa(uuid, numeric, text) from anon;

-- ---------------------------------------------------------
-- caixa_resumo: totais de vendas/recebimentos/movimentos por caixa
-- (security_invoker para respeitar RLS de quem consulta)
-- ---------------------------------------------------------
create or replace view caixa_resumo as
select
  c.id as caixa_id,
  coalesce(sum(v.total) filter (where v.forma_pagamento = 'a_vista' and v.status <> 'cancelado'), 0) as vendas_a_vista,
  coalesce(sum(v.total) filter (where v.forma_pagamento = 'fiado' and v.status <> 'cancelado'), 0) as vendas_fiado,
  coalesce(sum(v.total) filter (where v.forma_pagamento like 'boleto%' and v.status <> 'cancelado'), 0) as vendas_boleto,
  coalesce(sum(p.valor) filter (where p.forma_pagamento = 'dinheiro'), 0) as recebimentos_dinheiro,
  coalesce(sum(p.valor) filter (where p.forma_pagamento = 'pix'), 0) as recebimentos_pix,
  coalesce(sum(p.valor) filter (where p.forma_pagamento = 'transferencia'), 0) as recebimentos_transferencia,
  coalesce(sum(p.valor) filter (where p.forma_pagamento = 'cartao'), 0) as recebimentos_cartao,
  coalesce(sum(m.valor) filter (where m.tipo = 'sangria'), 0) as total_sangrias,
  coalesce(sum(m.valor) filter (where m.tipo = 'suprimento'), 0) as total_suprimentos
from caixas c
left join vendas v on v.caixa_id = c.id
left join pagamentos p on p.caixa_id = c.id
left join caixa_movimentos m on m.caixa_id = c.id
group by c.id;

alter view caixa_resumo set (security_invoker = on);

grant select on caixa_resumo to authenticated;

-- ---------------------------------------------------------
-- Revoga EXECUTE de PUBLIC (anon herda de PUBLIC por padrão), restringindo
-- as funções security definer apenas ao papel "authenticated".
-- ---------------------------------------------------------
revoke execute on function current_caixa_id() from public;
revoke execute on function abrir_caixa(numeric, text) from public;
revoke execute on function registrar_movimento_caixa(uuid, text, numeric, text) from public;
revoke execute on function fechar_caixa(uuid, numeric, text) from public;

revoke execute on function current_perfil() from public;
revoke execute on function current_cliente_id() from public;
revoke execute on function registrar_venda(uuid, text, text, jsonb) from public;
revoke execute on function cancelar_venda(uuid) from public;

grant execute on function current_caixa_id() to authenticated;
grant execute on function abrir_caixa(numeric, text) to authenticated;
grant execute on function registrar_movimento_caixa(uuid, text, numeric, text) to authenticated;
grant execute on function fechar_caixa(uuid, numeric, text) to authenticated;
grant execute on function current_perfil() to authenticated;
grant execute on function current_cliente_id() to authenticated;
grant execute on function registrar_venda(uuid, text, text, jsonb) to authenticated;
grant execute on function cancelar_venda(uuid) to authenticated;
