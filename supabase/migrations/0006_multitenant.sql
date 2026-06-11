-- =========================================================
-- CRM Depósito de Bebidas - Migration 0006
-- Módulo: Multi-tenant (empresas, super_admin, isolamento por empresa)
-- =========================================================

-- ---------------------------------------------------------
-- EMPRESAS (tenants do SaaS)
-- ---------------------------------------------------------
create table if not exists empresas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  email_contato text,
  plano text not null default 'padrao',
  valor_mensalidade numeric(12,2) not null default 0,
  status text not null default 'trial' check (status in ('trial', 'ativo', 'atrasado', 'suspenso', 'cancelado')),
  trial_fim date,
  vencimento date,
  observacoes text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- PROFILES: empresa_id + novo perfil super_admin
-- ---------------------------------------------------------
alter table profiles add column if not exists empresa_id uuid references empresas(id);

alter table profiles drop constraint if exists profiles_perfil_check;
alter table profiles add constraint profiles_perfil_check
  check (perfil in ('admin', 'vendedor', 'cliente', 'super_admin'));

-- ---------------------------------------------------------
-- current_empresa_id: empresa do usuário logado (security definer evita recursão de RLS)
-- ---------------------------------------------------------
create or replace function current_empresa_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select empresa_id from profiles where id = auth.uid();
$$;

grant execute on function current_empresa_id() to authenticated;

-- ---------------------------------------------------------
-- Adiciona empresa_id (ainda opcional) em todas as tabelas de negócio
-- ---------------------------------------------------------
alter table clientes add column if not exists empresa_id uuid references empresas(id);
alter table produtos add column if not exists empresa_id uuid references empresas(id);
alter table estoque_movimentos add column if not exists empresa_id uuid references empresas(id);
alter table casco_movimentos add column if not exists empresa_id uuid references empresas(id);
alter table vendas add column if not exists empresa_id uuid references empresas(id);
alter table venda_itens add column if not exists empresa_id uuid references empresas(id);
alter table pagamentos add column if not exists empresa_id uuid references empresas(id);
alter table caixas add column if not exists empresa_id uuid references empresas(id);
alter table caixa_movimentos add column if not exists empresa_id uuid references empresas(id);

-- ---------------------------------------------------------
-- Backfill: cria a empresa "original" com os dados já existentes
-- e promove a conta pessoal do dono do CRM a super_admin
-- ---------------------------------------------------------
do $$
declare
  v_empresa_id uuid;
begin
  insert into empresas (nome, status, plano)
  values ('Depósito (conta original)', 'ativo', 'padrao')
  returning id into v_empresa_id;

  update profiles set empresa_id = v_empresa_id
  where email <> 'wildejunior2025@gmail.com';

  update profiles set perfil = 'super_admin', empresa_id = null
  where email = 'wildejunior2025@gmail.com';

  update clientes set empresa_id = v_empresa_id where empresa_id is null;
  update produtos set empresa_id = v_empresa_id where empresa_id is null;
  update estoque_movimentos set empresa_id = v_empresa_id where empresa_id is null;
  update casco_movimentos set empresa_id = v_empresa_id where empresa_id is null;
  update vendas set empresa_id = v_empresa_id where empresa_id is null;
  update venda_itens set empresa_id = v_empresa_id where empresa_id is null;
  update pagamentos set empresa_id = v_empresa_id where empresa_id is null;
  update caixas set empresa_id = v_empresa_id where empresa_id is null;
  update caixa_movimentos set empresa_id = v_empresa_id where empresa_id is null;
end $$;

-- ---------------------------------------------------------
-- Torna empresa_id obrigatório com default automático
-- (mesmo padrão de current_caixa_id() na migration 0005: nenhum
-- INSERT existente lista empresa_id, então o default se aplica sozinho)
-- ---------------------------------------------------------
alter table clientes alter column empresa_id set not null;
alter table clientes alter column empresa_id set default current_empresa_id();
create index if not exists idx_clientes_empresa on clientes(empresa_id);

alter table produtos alter column empresa_id set not null;
alter table produtos alter column empresa_id set default current_empresa_id();
create index if not exists idx_produtos_empresa on produtos(empresa_id);

alter table estoque_movimentos alter column empresa_id set not null;
alter table estoque_movimentos alter column empresa_id set default current_empresa_id();
create index if not exists idx_estoque_movimentos_empresa on estoque_movimentos(empresa_id);

alter table casco_movimentos alter column empresa_id set not null;
alter table casco_movimentos alter column empresa_id set default current_empresa_id();
create index if not exists idx_casco_movimentos_empresa on casco_movimentos(empresa_id);

alter table vendas alter column empresa_id set not null;
alter table vendas alter column empresa_id set default current_empresa_id();
create index if not exists idx_vendas_empresa on vendas(empresa_id);

alter table venda_itens alter column empresa_id set not null;
alter table venda_itens alter column empresa_id set default current_empresa_id();
create index if not exists idx_venda_itens_empresa on venda_itens(empresa_id);

alter table pagamentos alter column empresa_id set not null;
alter table pagamentos alter column empresa_id set default current_empresa_id();
create index if not exists idx_pagamentos_empresa on pagamentos(empresa_id);

alter table caixas alter column empresa_id set not null;
alter table caixas alter column empresa_id set default current_empresa_id();
create index if not exists idx_caixas_empresa on caixas(empresa_id);

alter table caixa_movimentos alter column empresa_id set not null;
alter table caixa_movimentos alter column empresa_id set default current_empresa_id();
create index if not exists idx_caixa_movimentos_empresa on caixa_movimentos(empresa_id);

-- ---------------------------------------------------------
-- Views: filtra pela empresa do usuário logado
-- ---------------------------------------------------------
create or replace view estoque_saldo as
select
  p.id as produto_id,
  p.nome,
  p.categoria,
  p.estoque_minimo,
  coalesce(sum(
    case
      when m.tipo = 'entrada' then m.quantidade
      when m.tipo = 'saida' then -m.quantidade
      when m.tipo = 'ajuste' then m.quantidade
      else 0
    end
  ), 0) as quantidade_atual
from produtos p
left join estoque_movimentos m on m.produto_id = p.id
where p.empresa_id = current_empresa_id()
group by p.id, p.nome, p.categoria, p.estoque_minimo;

create or replace view casco_saldo as
select
  c.cliente_id,
  cl.nome as cliente_nome,
  c.produto_id,
  p.nome as produto_nome,
  coalesce(sum(
    case
      when c.tipo = 'entrega' then c.quantidade
      when c.tipo = 'devolucao' then -c.quantidade
      else 0
    end
  ), 0) as saldo_cascos
from casco_movimentos c
join clientes cl on cl.id = c.cliente_id
join produtos p on p.id = c.produto_id
where c.empresa_id = current_empresa_id()
group by c.cliente_id, cl.nome, c.produto_id, p.nome;

create or replace view clientes_saldo_fiado as
select
  cliente_id,
  coalesce(sum(valor), 0) as saldo_fiado
from (
  select cliente_id, total as valor
  from vendas
  where forma_pagamento <> 'a_vista'
    and status <> 'cancelado'
    and empresa_id = current_empresa_id()
  union all
  select cliente_id, -valor as valor
  from pagamentos
  where empresa_id = current_empresa_id()
) t
group by cliente_id;

alter view clientes_saldo_fiado set (security_invoker = on);

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
where c.empresa_id = current_empresa_id()
group by c.id;

alter view caixa_resumo set (security_invoker = on);

grant select on estoque_saldo to authenticated;
grant select on casco_saldo to authenticated;
grant select on clientes_saldo_fiado to authenticated;
grant select on caixa_resumo to authenticated;

-- ---------------------------------------------------------
-- RLS: empresas
-- ---------------------------------------------------------
alter table empresas enable row level security;

create policy "Super admin gerencia empresas"
  on empresas for all
  using (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');

create policy "Usuario ve a propria empresa"
  on empresas for select
  using (id = current_empresa_id());

grant select on empresas to authenticated;

-- ---------------------------------------------------------
-- RLS: profiles (acrescenta isolamento por empresa + super_admin)
-- ---------------------------------------------------------
drop policy if exists "Usuario ve o proprio perfil ou admin ve todos" on profiles;
drop policy if exists "Admin gerencia perfis" on profiles;

create policy "Usuario ve o proprio perfil ou admin ve todos"
  on profiles for select
  using (
    id = auth.uid()
    or current_perfil() = 'super_admin'
    or (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  );

create policy "Admin gerencia perfis"
  on profiles for update
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

-- ---------------------------------------------------------
-- RLS: clientes
-- ---------------------------------------------------------
drop policy if exists "Admin e vendedor gerenciam clientes" on clientes;
drop policy if exists "Cliente ve o proprio cadastro" on clientes;
drop policy if exists "Cliente atualiza o proprio cadastro" on clientes;

create policy "Admin e vendedor gerenciam clientes"
  on clientes for all
  using (current_perfil() in ('admin', 'vendedor') and empresa_id = current_empresa_id())
  with check (current_perfil() in ('admin', 'vendedor') and empresa_id = current_empresa_id());

create policy "Cliente ve o proprio cadastro"
  on clientes for select
  using (current_perfil() = 'cliente' and id = current_cliente_id() and empresa_id = current_empresa_id());

create policy "Cliente atualiza o proprio cadastro"
  on clientes for update
  using (current_perfil() = 'cliente' and id = current_cliente_id() and empresa_id = current_empresa_id())
  with check (current_perfil() = 'cliente' and id = current_cliente_id() and empresa_id = current_empresa_id());

-- ---------------------------------------------------------
-- RLS: produtos
-- ---------------------------------------------------------
drop policy if exists "Leitura de produtos para autenticados" on produtos;
drop policy if exists "Admin gerencia produtos" on produtos;

create policy "Leitura de produtos para autenticados"
  on produtos for select
  using (auth.role() = 'authenticated' and empresa_id = current_empresa_id());

create policy "Admin gerencia produtos"
  on produtos for all
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

-- ---------------------------------------------------------
-- RLS: estoque_movimentos
-- ---------------------------------------------------------
drop policy if exists "Admin gerencia movimentos de estoque" on estoque_movimentos;

create policy "Admin gerencia movimentos de estoque"
  on estoque_movimentos for all
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

-- ---------------------------------------------------------
-- RLS: casco_movimentos
-- ---------------------------------------------------------
drop policy if exists "Admin gerencia movimentos de casco" on casco_movimentos;

create policy "Admin gerencia movimentos de casco"
  on casco_movimentos for all
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

-- ---------------------------------------------------------
-- RLS: vendas / venda_itens
-- ---------------------------------------------------------
drop policy if exists "Admin e vendedor gerenciam vendas" on vendas;
drop policy if exists "Cliente ve os proprios pedidos" on vendas;
drop policy if exists "Admin e vendedor gerenciam itens de venda" on venda_itens;
drop policy if exists "Cliente ve itens dos proprios pedidos" on venda_itens;

create policy "Admin e vendedor gerenciam vendas"
  on vendas for all
  using (current_perfil() in ('admin', 'vendedor') and empresa_id = current_empresa_id())
  with check (current_perfil() in ('admin', 'vendedor') and empresa_id = current_empresa_id());

create policy "Cliente ve os proprios pedidos"
  on vendas for select
  using (current_perfil() = 'cliente' and cliente_id = current_cliente_id() and empresa_id = current_empresa_id());

create policy "Admin e vendedor gerenciam itens de venda"
  on venda_itens for all
  using (current_perfil() in ('admin', 'vendedor') and empresa_id = current_empresa_id())
  with check (current_perfil() in ('admin', 'vendedor') and empresa_id = current_empresa_id());

create policy "Cliente ve itens dos proprios pedidos"
  on venda_itens for select
  using (
    current_perfil() = 'cliente'
    and empresa_id = current_empresa_id()
    and exists (
      select 1 from vendas v
      where v.id = venda_itens.venda_id
        and v.cliente_id = current_cliente_id()
    )
  );

-- ---------------------------------------------------------
-- RLS: pagamentos
-- ---------------------------------------------------------
drop policy if exists "Admin gerencia pagamentos" on pagamentos;
drop policy if exists "Cliente ve os proprios pagamentos" on pagamentos;

create policy "Admin gerencia pagamentos"
  on pagamentos for all
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

create policy "Cliente ve os proprios pagamentos"
  on pagamentos for select
  using (current_perfil() = 'cliente' and cliente_id = current_cliente_id() and empresa_id = current_empresa_id());

-- ---------------------------------------------------------
-- RLS: caixas / caixa_movimentos
-- ---------------------------------------------------------
drop policy if exists "Usuario ve os proprios caixas ou admin ve todos" on caixas;
drop policy if exists "Admin gerencia caixas" on caixas;
drop policy if exists "Usuario ve os proprios movimentos de caixa ou admin ve todos" on caixa_movimentos;
drop policy if exists "Admin gerencia movimentos de caixa" on caixa_movimentos;

create policy "Usuario ve os proprios caixas ou admin ve todos"
  on caixas for select
  using (
    empresa_id = current_empresa_id()
    and (current_perfil() = 'admin' or aberto_por = auth.uid())
  );

create policy "Admin gerencia caixas"
  on caixas for all
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

create policy "Usuario ve os proprios movimentos de caixa ou admin ve todos"
  on caixa_movimentos for select
  using (
    empresa_id = current_empresa_id()
    and (
      current_perfil() = 'admin'
      or exists (
        select 1 from caixas c
        where c.id = caixa_movimentos.caixa_id
          and c.aberto_por = auth.uid()
      )
    )
  );

create policy "Admin gerencia movimentos de caixa"
  on caixa_movimentos for all
  using (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

-- ---------------------------------------------------------
-- marcar_pagamento_empresa: super_admin atualiza status/vencimento da assinatura
-- ---------------------------------------------------------
create or replace function marcar_pagamento_empresa(
  p_empresa_id uuid,
  p_novo_status text,
  p_novo_vencimento date default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_perfil() <> 'super_admin' then
    raise exception 'Sem permissão';
  end if;

  if p_novo_status not in ('trial', 'ativo', 'atrasado', 'suspenso', 'cancelado') then
    raise exception 'Status inválido';
  end if;

  update empresas
  set status = p_novo_status,
      vencimento = coalesce(p_novo_vencimento, vencimento)
  where id = p_empresa_id;
end;
$$;

grant execute on function marcar_pagamento_empresa(uuid, text, date) to authenticated;

-- ---------------------------------------------------------
-- handle_new_user: agora trata 3 fluxos de cadastro
-- - tipo_cadastro = 'empresa': cria empresa nova (trial) + profile admin
-- - tipo_cadastro = 'cliente' + empresa_id: profile cliente vinculado à empresa
-- - fallback: profile cliente sem empresa (bloqueado até vinculação)
-- ---------------------------------------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo text;
  v_empresa_id uuid;
begin
  v_tipo := new.raw_user_meta_data->>'tipo_cadastro';

  if v_tipo = 'empresa' then
    insert into empresas (nome, status, plano, trial_fim)
    values (
      coalesce(new.raw_user_meta_data->>'nome_empresa', 'Minha empresa'),
      'trial',
      'padrao',
      (now() + interval '14 days')::date
    )
    returning id into v_empresa_id;

    insert into profiles (id, nome, email, perfil, empresa_id)
    values (new.id, coalesce(new.raw_user_meta_data->>'nome', new.email), new.email, 'admin', v_empresa_id)
    on conflict (id) do nothing;

  elsif v_tipo = 'cliente' and (new.raw_user_meta_data->>'empresa_id') is not null then
    insert into profiles (id, nome, email, perfil, empresa_id)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'nome', new.email),
      new.email,
      'cliente',
      (new.raw_user_meta_data->>'empresa_id')::uuid
    )
    on conflict (id) do nothing;

  else
    insert into profiles (id, nome, email, perfil)
    values (new.id, coalesce(new.raw_user_meta_data->>'nome', new.email), new.email, 'cliente')
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------
-- Revoga EXECUTE de PUBLIC (anon/authenticated herdam de PUBLIC por padrão)
-- ---------------------------------------------------------
revoke execute on function current_empresa_id() from anon;
revoke execute on function current_empresa_id() from public;
revoke execute on function marcar_pagamento_empresa(uuid, text, date) from anon;
revoke execute on function marcar_pagamento_empresa(uuid, text, date) from public;

grant execute on function current_empresa_id() to authenticated;
grant execute on function marcar_pagamento_empresa(uuid, text, date) to authenticated;
