-- =========================================================
-- CRM Depósito de Bebidas - Migration 0016
-- WhatsApp SaaS: URL/APIKey movidos para env vars da Edge Function
-- Cada empresa usa instância auto-nomeada empresa_<id>
-- =========================================================

-- Remove colunas que vão para variáveis de ambiente (super_admin configura uma vez)
alter table whatsapp_config
  drop column if exists api_url,
  drop column if exists api_key;

-- instance_name: allow null/empty (backward compat; preenchido automaticamente ao conectar)
alter table whatsapp_config
  alter column instance_name drop not null;

alter table whatsapp_config
  alter column instance_name set default '';
