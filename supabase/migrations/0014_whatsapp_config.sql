-- =========================================================
-- CRM Depósito de Bebidas - Migration 0014
-- Módulo: Configuração WhatsApp (Evolution API por empresa)
-- =========================================================

create table whatsapp_config (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  api_url text not null default '',
  api_key text not null default '',
  instance_name text not null default '',
  ativo boolean not null default false,
  notif_pedido boolean not null default true,
  notif_fiado boolean not null default false,
  msg_pedido text not null default 'Olá {nome}! 🎉 Seu pedido foi recebido. Em breve entraremos em contato para confirmar a entrega.',
  msg_fiado text not null default 'Olá {nome}! Você possui R$ {valor} em aberto no fiado. Pode entrar em contato conosco para regularizar? Obrigado!',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(empresa_id)
);

alter table whatsapp_config enable row level security;

create policy "Admin gerencia whatsapp da propria empresa"
  on whatsapp_config for all
  using (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());
