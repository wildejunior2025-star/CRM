-- =========================================================
-- CRM Depósito de Bebidas - Migration 0003
-- Módulo: Financeiro / Fiado
-- =========================================================

-- ---------------------------------------------------------
-- PAGAMENTOS (recebimentos de clientes, abatem o fiado)
-- ---------------------------------------------------------
create table if not exists pagamentos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id),
  valor numeric(12,2) not null,
  forma_pagamento text not null default 'dinheiro', -- dinheiro, pix, transferencia, cartao
  observacao text,
  created_at timestamptz not null default now()
);

create index if not exists idx_pagamentos_cliente on pagamentos(cliente_id);

-- ---------------------------------------------------------
-- View com saldo "fiado" em aberto por cliente
-- (vendas a prazo não canceladas - pagamentos recebidos)
-- ---------------------------------------------------------
create or replace view clientes_saldo_fiado as
select
  cliente_id,
  coalesce(sum(valor), 0) as saldo_fiado
from (
  select cliente_id, total as valor
  from vendas
  where forma_pagamento <> 'a_vista'
    and status <> 'cancelado'
  union all
  select cliente_id, -valor as valor
  from pagamentos
) t
group by cliente_id;

alter view clientes_saldo_fiado set (security_invoker = on);

-- ---------------------------------------------------------
-- RLS
-- ---------------------------------------------------------
alter table pagamentos enable row level security;

create policy "Usuários autenticados podem tudo - pagamentos"
  on pagamentos for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
