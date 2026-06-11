-- =========================================================
-- CRM Depósito de Bebidas - Migration 0004
-- Módulo: Perfis de usuário (admin / vendedor / cliente)
-- =========================================================

-- ---------------------------------------------------------
-- PROFILES
-- ---------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text,
  email text,
  perfil text not null default 'cliente' check (perfil in ('admin', 'vendedor', 'cliente')),
  cliente_id uuid references clientes(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_profiles_cliente on profiles(cliente_id);

-- ---------------------------------------------------------
-- Helper functions (security definer evita recursão de RLS)
-- ---------------------------------------------------------
create or replace function current_perfil()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select perfil from profiles where id = auth.uid();
$$;

create or replace function current_cliente_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select cliente_id from profiles where id = auth.uid();
$$;

grant execute on function current_perfil() to authenticated;
grant execute on function current_cliente_id() to authenticated;

-- ---------------------------------------------------------
-- Trigger: cria profile automaticamente ao criar usuário
-- (perfil padrão 'cliente'; admin promove depois na tela de Usuários)
-- ---------------------------------------------------------
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, nome, email, perfil)
  values (new.id, coalesce(new.raw_user_meta_data->>'nome', new.email), new.email, 'cliente')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill: usuários existentes ganham profile (primeiro usuário vira admin)
insert into profiles (id, nome, email, perfil)
select id, email, email, 'admin' from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------
-- RLS - profiles
-- ---------------------------------------------------------
alter table profiles enable row level security;

create policy "Usuario ve o proprio perfil ou admin ve todos"
  on profiles for select
  using (id = auth.uid() or current_perfil() = 'admin');

create policy "Admin gerencia perfis"
  on profiles for update
  using (current_perfil() = 'admin')
  with check (current_perfil() = 'admin');

grant select, update on profiles to authenticated;

-- ---------------------------------------------------------
-- RLS - produtos
-- (leitura liberada para autenticados; escrita só admin)
-- ---------------------------------------------------------
drop policy if exists "Usuários autenticados podem tudo - produtos" on produtos;

create policy "Leitura de produtos para autenticados"
  on produtos for select
  using (auth.role() = 'authenticated');

create policy "Admin gerencia produtos"
  on produtos for all
  using (current_perfil() = 'admin')
  with check (current_perfil() = 'admin');

-- ---------------------------------------------------------
-- RLS - estoque_movimentos (só admin lê/escreve diretamente;
-- vendas dão baixa via função security definer)
-- ---------------------------------------------------------
drop policy if exists "Usuários autenticados podem tudo - estoque_movimentos" on estoque_movimentos;

create policy "Admin gerencia movimentos de estoque"
  on estoque_movimentos for all
  using (current_perfil() = 'admin')
  with check (current_perfil() = 'admin');

-- ---------------------------------------------------------
-- RLS - casco_movimentos (só admin lê/escreve diretamente;
-- vendas dão entrega/devolução via função security definer)
-- ---------------------------------------------------------
drop policy if exists "Usuários autenticados podem tudo - casco_movimentos" on casco_movimentos;

create policy "Admin gerencia movimentos de casco"
  on casco_movimentos for all
  using (current_perfil() = 'admin')
  with check (current_perfil() = 'admin');

-- ---------------------------------------------------------
-- RLS - clientes (admin/vendedor gerenciam todos;
-- cliente vê e edita apenas o próprio cadastro)
-- ---------------------------------------------------------
drop policy if exists "Usuários autenticados podem tudo - clientes" on clientes;

create policy "Admin e vendedor gerenciam clientes"
  on clientes for all
  using (current_perfil() in ('admin', 'vendedor'))
  with check (current_perfil() in ('admin', 'vendedor'));

create policy "Cliente ve o proprio cadastro"
  on clientes for select
  using (current_perfil() = 'cliente' and id = current_cliente_id());

create policy "Cliente atualiza o proprio cadastro"
  on clientes for update
  using (current_perfil() = 'cliente' and id = current_cliente_id())
  with check (current_perfil() = 'cliente' and id = current_cliente_id());

-- ---------------------------------------------------------
-- RLS - vendas / venda_itens
-- (admin/vendedor gerenciam tudo; cliente vê apenas seus pedidos)
-- ---------------------------------------------------------
drop policy if exists "Usuários autenticados podem tudo - vendas" on vendas;
drop policy if exists "Usuários autenticados podem tudo - venda_itens" on venda_itens;

create policy "Admin e vendedor gerenciam vendas"
  on vendas for all
  using (current_perfil() in ('admin', 'vendedor'))
  with check (current_perfil() in ('admin', 'vendedor'));

create policy "Cliente ve os proprios pedidos"
  on vendas for select
  using (current_perfil() = 'cliente' and cliente_id = current_cliente_id());

create policy "Admin e vendedor gerenciam itens de venda"
  on venda_itens for all
  using (current_perfil() in ('admin', 'vendedor'))
  with check (current_perfil() in ('admin', 'vendedor'));

create policy "Cliente ve itens dos proprios pedidos"
  on venda_itens for select
  using (
    current_perfil() = 'cliente'
    and exists (
      select 1 from vendas v
      where v.id = venda_itens.venda_id
        and v.cliente_id = current_cliente_id()
    )
  );

-- ---------------------------------------------------------
-- RLS - pagamentos (só admin gerencia; cliente vê os próprios)
-- ---------------------------------------------------------
drop policy if exists "Usuários autenticados podem tudo - pagamentos" on pagamentos;

create policy "Admin gerencia pagamentos"
  on pagamentos for all
  using (current_perfil() = 'admin')
  with check (current_perfil() = 'admin');

create policy "Cliente ve os proprios pagamentos"
  on pagamentos for select
  using (current_perfil() = 'cliente' and cliente_id = current_cliente_id());

-- ---------------------------------------------------------
-- registrar_venda: agora security definer, com checagem de perfil.
-- admin/vendedor podem vender para qualquer cliente;
-- cliente só pode registrar pedido para si mesmo (portal/whatsapp/app).
-- ---------------------------------------------------------
create or replace function registrar_venda(
  p_cliente_id uuid,
  p_forma_pagamento text,
  p_observacoes text,
  p_itens jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_venda_id uuid;
  v_item jsonb;
  v_total numeric(12,2) := 0;
  v_quantidade numeric(12,2);
  v_preco numeric(12,2);
  v_produto_id uuid;
  v_controla_casco boolean;
  v_perfil text;
begin
  v_perfil := current_perfil();

  if v_perfil = 'cliente' then
    if p_cliente_id is distinct from current_cliente_id() then
      raise exception 'Cliente só pode registrar pedidos para si mesmo';
    end if;
  elsif v_perfil not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para registrar vendas';
  end if;

  if jsonb_array_length(p_itens) = 0 then
    raise exception 'A venda precisa ter pelo menos um item';
  end if;

  insert into vendas (cliente_id, forma_pagamento, observacoes, status, total)
  values (p_cliente_id, p_forma_pagamento, p_observacoes, 'pedido', 0)
  returning id into v_venda_id;

  for v_item in select * from jsonb_array_elements(p_itens)
  loop
    v_produto_id := (v_item->>'produto_id')::uuid;
    v_quantidade := (v_item->>'quantidade')::numeric;
    v_preco := (v_item->>'preco_unitario')::numeric;

    if v_quantidade <= 0 then
      raise exception 'Quantidade inválida para o produto %', v_produto_id;
    end if;

    insert into venda_itens (venda_id, produto_id, quantidade, preco_unitario, subtotal)
    values (v_venda_id, v_produto_id, v_quantidade, v_preco, v_quantidade * v_preco);

    v_total := v_total + (v_quantidade * v_preco);

    insert into estoque_movimentos (produto_id, tipo, quantidade, motivo, observacao)
    values (v_produto_id, 'saida', v_quantidade, 'venda', 'Venda ' || v_venda_id);

    select controla_casco into v_controla_casco from produtos where id = v_produto_id;

    if v_controla_casco then
      insert into casco_movimentos (cliente_id, produto_id, tipo, quantidade, observacao)
      values (p_cliente_id, v_produto_id, 'entrega', v_quantidade, 'Venda ' || v_venda_id);
    end if;
  end loop;

  update vendas set total = v_total where id = v_venda_id;

  return v_venda_id;
end;
$$;

-- ---------------------------------------------------------
-- cancelar_venda: agora security definer, restrito a admin/vendedor.
-- ---------------------------------------------------------
create or replace function cancelar_venda(p_venda_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_cliente_id uuid;
  v_item record;
  v_controla_casco boolean;
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para cancelar vendas';
  end if;

  select status, cliente_id into v_status, v_cliente_id from vendas where id = p_venda_id;

  if v_status is null then
    raise exception 'Venda não encontrada';
  end if;

  if v_status = 'cancelado' then
    raise exception 'Venda já está cancelada';
  end if;

  for v_item in select produto_id, quantidade from venda_itens where venda_id = p_venda_id
  loop
    insert into estoque_movimentos (produto_id, tipo, quantidade, motivo, observacao)
    values (v_item.produto_id, 'entrada', v_item.quantidade, 'devolucao', 'Cancelamento venda ' || p_venda_id);

    select controla_casco into v_controla_casco from produtos where id = v_item.produto_id;

    if v_controla_casco then
      insert into casco_movimentos (cliente_id, produto_id, tipo, quantidade, observacao)
      values (v_cliente_id, v_item.produto_id, 'devolucao', v_item.quantidade, 'Cancelamento venda ' || p_venda_id);
    end if;
  end loop;

  update vendas set status = 'cancelado' where id = p_venda_id;
end;
$$;

grant execute on function registrar_venda(uuid, text, text, jsonb) to authenticated;
grant execute on function cancelar_venda(uuid) to authenticated;

-- Funções internas/RPCs não devem ser chamáveis por usuários anônimos
revoke execute on function current_perfil() from anon;
revoke execute on function current_cliente_id() from anon;
revoke execute on function registrar_venda(uuid, text, text, jsonb) from anon;
revoke execute on function cancelar_venda(uuid) from anon;
revoke execute on function handle_new_user() from anon, authenticated, public;
