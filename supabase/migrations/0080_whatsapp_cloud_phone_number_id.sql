-- Migração para o WhatsApp Cloud API (Meta) — Fase 2 da escala.
-- Cada loja continua com whatsapp_config; a diferença é o "cano":
--   - Evolution (antigo): roteia por instance_name
--   - Cloud API (novo):   roteia por cloud_phone_number_id (o Phone Number ID da Meta)
-- Uma loja migrada tem cloud_phone_number_id preenchido; o webhook whatsapp-cloud
-- acha a loja por esse id. As lojas ainda no Evolution ficam com o campo NULL.

alter table public.whatsapp_config
  add column if not exists cloud_phone_number_id text,
  add column if not exists cloud_display_number  text;

comment on column public.whatsapp_config.cloud_phone_number_id is
  'Phone Number ID da Meta (WhatsApp Cloud API). Quando preenchido, a loja recebe/envia pelo webhook whatsapp-cloud em vez do Evolution.';
comment on column public.whatsapp_config.cloud_display_number is
  'Número de exibição (E.164) associado ao cloud_phone_number_id, só para referência no gestor.';

-- Busca rápida do webhook: phone_number_id -> loja. Único porque um número atende uma loja.
create unique index if not exists whatsapp_config_cloud_phone_number_id_key
  on public.whatsapp_config (cloud_phone_number_id)
  where cloud_phone_number_id is not null;
