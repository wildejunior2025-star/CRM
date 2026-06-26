-- =========================================================
-- CRM Depósito de Bebidas - Migration 0017
-- Sistema de créditos WhatsApp por empresa
-- =========================================================

-- Adiciona créditos WhatsApp às empresas
alter table empresas add column if not exists whatsapp_creditos integer not null default 0;

-- Tabela de histórico de consumo de créditos
create table if not exists whatsapp_creditos_log (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  tipo text not null check (tipo in ('credito', 'debito')),
  quantidade integer not null,
  descricao text,
  created_at timestamptz default now()
);

alter table whatsapp_creditos_log enable row level security;

-- Super admin pode ver tudo
create policy "super_admin pode ver logs" on whatsapp_creditos_log
  for select using (
    exists (
      select 1 from profiles where id = auth.uid() and perfil = 'super_admin'
    )
  );

-- Admin pode ver logs da sua empresa
create policy "admin pode ver seus logs" on whatsapp_creditos_log
  for select using (
    empresa_id = current_empresa_id()
  );
