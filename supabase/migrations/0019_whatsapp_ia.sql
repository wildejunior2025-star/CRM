-- =========================================================
-- CRM Depósito de Bebidas - Migration 0019
-- Vendedor IA no WhatsApp: histórico de conversa e carrinho
-- =========================================================

-- Toggle IA na config de WhatsApp
alter table whatsapp_config add column if not exists ia_ativo boolean default false;

-- Histórico de conversas IA por empresa+telefone
create table if not exists whatsapp_conversas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  phone text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz default now()
);

create index if not exists whatsapp_conversas_empresa_phone
  on whatsapp_conversas (empresa_id, phone, created_at desc);

alter table whatsapp_conversas enable row level security;

-- service_role tem acesso total (webhook usa service_role key)
create policy "service_role acesso total" on whatsapp_conversas
  for all using (true);

-- Carrinho IA (pedido em construção via WhatsApp)
create table if not exists whatsapp_carrinho (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  phone text not null,
  items jsonb not null default '[]',
  updated_at timestamptz default now(),
  unique (empresa_id, phone)
);

alter table whatsapp_carrinho enable row level security;

create policy "service_role acesso total carrinho" on whatsapp_carrinho
  for all using (true);
