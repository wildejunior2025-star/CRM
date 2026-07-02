-- Cadastro Incorporado (Embedded Signup) do WhatsApp Cloud API.
-- Cada loja conecta o PRÓPRIO número pela Meta (popup), e o CRM guarda aqui os
-- identificadores necessários pra registrar/enviar. Complementa a migração 0080.

alter table public.whatsapp_config
  add column if not exists cloud_waba_id text,           -- WhatsApp Business Account ID da loja
  add column if not exists cloud_pin     text,           -- PIN de verificação em duas etapas (registro Cloud API)
  add column if not exists cloud_verified_name text;     -- nome verificado que aparece pro cliente

comment on column public.whatsapp_config.cloud_waba_id is
  'WABA ID (WhatsApp Business Account) da loja, obtido no Cadastro Incorporado.';
comment on column public.whatsapp_config.cloud_pin is
  'PIN de 6 dígitos usado no registro do número no Cloud API (verificação em duas etapas).';
comment on column public.whatsapp_config.cloud_verified_name is
  'Nome verificado do WhatsApp Business que o cliente vê.';
