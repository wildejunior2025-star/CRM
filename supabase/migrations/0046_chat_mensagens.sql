-- Caixa de entrada multicanal: mensagens entre loja e cliente.
-- Conversa = (empresa_id, canal, cliente_ref).
create table if not exists public.mensagens_chat (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  canal         text not null check (canal in ('app','lojaonline','whatsapp')),
  cliente_ref   text not null,                 -- user_id (app) ou telefone (lojaonline/whatsapp)
  cliente_nome  text,
  remetente     text not null check (remetente in ('cliente','loja')),
  texto         text not null,
  lida          boolean not null default false,        -- lida pela loja
  lida_cliente  boolean not null default false,        -- lida pelo cliente
  created_at    timestamptz not null default now()
);

create index if not exists idx_mensagens_chat_thread
  on public.mensagens_chat (empresa_id, canal, cliente_ref, created_at);

alter table public.mensagens_chat enable row level security;

-- Loja (admin/vendedor da empresa): vê e responde tudo da própria empresa
create policy "chat loja select" on public.mensagens_chat
  for select to authenticated using (empresa_id = current_empresa_id());
create policy "chat loja insert" on public.mensagens_chat
  for insert to authenticated with check (empresa_id = current_empresa_id() and remetente = 'loja');
create policy "chat loja update" on public.mensagens_chat
  for update to authenticated using (empresa_id = current_empresa_id());

-- Cliente do app: só as próprias conversas (canal app)
create policy "chat cliente select" on public.mensagens_chat
  for select to authenticated using (canal = 'app' and cliente_ref = auth.uid()::text);
create policy "chat cliente insert" on public.mensagens_chat
  for insert to authenticated with check (canal = 'app' and cliente_ref = auth.uid()::text and remetente = 'cliente');
create policy "chat cliente update" on public.mensagens_chat
  for update to authenticated using (canal = 'app' and cliente_ref = auth.uid()::text);

-- Realtime
alter publication supabase_realtime add table public.mensagens_chat;
