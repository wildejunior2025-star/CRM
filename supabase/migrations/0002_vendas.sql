-- =========================================================
-- CRM Depósito de Bebidas - Migration 0002
-- Módulo: Vendas / Pedidos
-- =========================================================

-- ---------------------------------------------------------
-- VENDAS (pedidos)
-- ---------------------------------------------------------
create table if not exists vendas (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id),
  status text not null default 'pedido', -- pedido, entregue, cancelado
  forma_pagamento text not null default 'a_vista', -- a_vista, fiado, boleto_7d, boleto_14d, boleto_30d
  total numeric(12,2) not null default 0,
  observacoes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_vendas_cliente on vendas(cliente_id);

-- ---------------------------------------------------------
-- ITENS DA VENDA
-- ---------------------------------------------------------
create table if not exists venda_itens (
  id uuid primary key default gen_random_uuid(),
  venda_id uuid not null references vendas(id) on delete cascade,
  produto_id uuid not null references produtos(id),
  quantidade numeric(12,2) not null,
  preco_unitario numeric(12,2) not null,
  subtotal numeric(12,2) not null
);

create index if not exists idx_venda_itens_venda on venda_itens(venda_id);

-- View com saldo "fiado" em aberto por cliente (vendas a prazo não canceladas)
create or replace view clientes_saldo_fiado as
select
  cliente_id,
  coalesce(sum(total), 0) as saldo_fiado
from vendas
where forma_pagamento <> 'a_vista'
  and status <> 'cancelado'
group by cliente_id;

-- ---------------------------------------------------------
-- registrar_venda: cria a venda, os itens, dá baixa no estoque
-- e registra entrega de cascos para produtos retornáveis.
-- p_itens: jsonb array de {produto_id, quantidade, preco_unitario}
-- ---------------------------------------------------------
create or replace function registrar_venda(
  p_cliente_id uuid,
  p_forma_pagamento text,
  p_observacoes text,
  p_itens jsonb
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_venda_id uuid;
  v_item jsonb;
  v_total numeric(12,2) := 0;
  v_quantidade numeric(12,2);
  v_preco numeric(12,2);
  v_produto_id uuid;
  v_controla_casco boolean;
begin
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
-- cancelar_venda: estorna estoque e cascos de uma venda não cancelada
-- ---------------------------------------------------------
create or replace function cancelar_venda(p_venda_id uuid) returns void
language plpgsql
security invoker
as $$
declare
  v_status text;
  v_cliente_id uuid;
  v_item record;
  v_controla_casco boolean;
begin
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

-- ---------------------------------------------------------
-- RLS
-- ---------------------------------------------------------
alter table vendas enable row level security;
alter table venda_itens enable row level security;

create policy "Usuários autenticados podem tudo - vendas"
  on vendas for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create policy "Usuários autenticados podem tudo - venda_itens"
  on venda_itens for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

grant execute on function registrar_venda(uuid, text, text, jsonb) to authenticated;
grant execute on function cancelar_venda(uuid) to authenticated;
