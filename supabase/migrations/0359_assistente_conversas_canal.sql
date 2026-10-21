-- 0359 — de onde veio o uso da carteira de IA (portal | whatsapp_pergunta | whatsapp_estoque)
alter table assistente_conversas add column if not exists canal text not null default 'portal';
comment on column assistente_conversas.canal is 'portal | whatsapp_pergunta | whatsapp_estoque — de onde veio o uso da carteira de IA.';
