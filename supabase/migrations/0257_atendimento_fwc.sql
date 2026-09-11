-- =========================================================
-- Migration 0257 - Atendimento FWC: a conversa do número oficial no Super ADM
-- =========================================================
-- O número oficial da FWC ("FWC Inter", Cloud API) não tem celular nenhum:
-- ele mora só na Meta. Então não existe "abrir o WhatsApp e responder" — o
-- lojista que respondia a cobrança da mensalidade falava sozinho. Pior: o
-- número estava plugado também numa loja (deposito de Thiago) com o robô
-- ligado, e quem respondia a cobrança recebia o cardápio do depósito.
--
-- A partir daqui:
--   * o whatsapp-cloud reconhece o número da plataforma
--     (config_global.admin_cloud_phone_number_id) ANTES de procurar loja, e
--     grava a mensagem aqui, sem robô nenhum;
--   * o Super ADM lê e responde por uma janela de chat (admin-chat);
--   * a cobrança que o admin-alertas manda também entra na conversa, pra quem
--     atende ver a que o lojista está respondendo.
--
-- Tabela separada de mensagens_chat de propósito: aquela é POR LOJA
-- (empresa_id obrigatório, RLS por current_empresa_id). Esta é da plataforma,
-- e só o super admin enxerga.
-- =========================================================

create table if not exists admin_chat (
  id              uuid primary key default gen_random_uuid(),
  -- Como a Meta entregou (celular do Nordeste costuma vir SEM o 9). A conversa
  -- é agrupada pelos 8 últimos dígitos, igual ao resto do sistema.
  telefone        text not null,
  -- Nome do perfil do WhatsApp da pessoa (vem no webhook).
  nome            text,
  -- Lojista reconhecido pelo telefone_contato da loja, quando bate.
  empresa_id      uuid references empresas(id) on delete set null,
  remetente       text not null check (remetente in ('cliente', 'fwc')),
  texto           text not null,
  -- 'modelo' = template aprovado (único jeito de escrever primeiro, fora das 24h).
  tipo            text not null default 'texto' check (tipo in ('texto', 'modelo', 'midia')),
  midia_path      text,
  midia_tipo      text,
  midia_expira_em timestamptz,
  -- wamid da Meta: é por ele que o aviso de entrega acha a linha.
  message_id      text,
  status          text,
  erro            text,
  lida            boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists admin_chat_telefone_idx on admin_chat (telefone, created_at desc);
create index if not exists admin_chat_message_id_idx on admin_chat (message_id) where message_id is not null;
create index if not exists admin_chat_nao_lidas_idx on admin_chat (created_at) where remetente = 'cliente' and lida = false;

comment on table admin_chat is
  'Conversas do número oficial da FWC (Cloud API) com lojistas. Só o super admin lê; quem grava é o whatsapp-cloud, o admin-chat e o admin-alertas (service role). Mig 0257.';

alter table admin_chat enable row level security;

drop policy if exists "super admin le atendimento" on admin_chat;
create policy "super admin le atendimento" on admin_chat
  for select using (current_perfil() = 'super_admin');

-- Só pra marcar como lida. Gravar mensagem é sempre pelo servidor: é ele que
-- manda pela Meta e sabe se saiu.
drop policy if exists "super admin marca lida" on admin_chat;
create policy "super admin marca lida" on admin_chat
  for update using (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'admin_chat'
  ) then
    alter publication supabase_realtime add table public.admin_chat;
  end if;
end $$;

-- ── Foto/áudio que o lojista manda ──────────────────────────────────────────
-- Mesmo bucket e mesma regra de 24h das lojas (mig 0242), na pasta "admin/".
-- A política das lojas compara a 1ª pasta com current_empresa_id(), que para
-- o super admin é nulo — sem esta, ele não abriria nada.
drop policy if exists "chat-midias super admin le" on storage.objects;
create policy "chat-midias super admin le" on storage.objects
  for select using (
    bucket_id = 'chat-midias'
    and (storage.foldername(name))[1] = 'admin'
    and public.current_perfil() = 'super_admin'
  );

-- A faxina de hora em hora passa a limpar as duas tabelas. Mesma assinatura,
-- então a edge function limpar-midias-chat não muda.
create or replace function public.midias_do_chat_vencidas(p_limite integer default 500)
returns table(id uuid, midia_path text)
language sql
security definer
set search_path to 'public'
as $function$
  select x.id, x.midia_path
  from (
    select m.id, m.midia_path, m.midia_expira_em
      from mensagens_chat m
     where m.midia_path is not null and m.midia_expira_em is not null and m.midia_expira_em < now()
    union all
    select a.id, a.midia_path, a.midia_expira_em
      from admin_chat a
     where a.midia_path is not null and a.midia_expira_em is not null and a.midia_expira_em < now()
  ) x
  order by x.midia_expira_em
  limit greatest(1, least(p_limite, 2000));
$function$;

create or replace function public.marcar_midias_apagadas(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_n int; v_m int;
begin
  update mensagens_chat set midia_path = null, midia_expira_em = null where id = any(p_ids);
  get diagnostics v_n = row_count;
  update admin_chat set midia_path = null, midia_expira_em = null where id = any(p_ids);
  get diagnostics v_m = row_count;
  return v_n + v_m;
end;
$function$;

-- ── O número da plataforma deixa de ser de loja ─────────────────────────────
-- Enquanto uma loja tiver o número no cadastro, o envio pelo painel dela
-- (whatsapp-connect) sairia com o nome "FWC Inter". Guarda o que estava lá e
-- desliga. A loja continua existindo e o teste simulado dela (?test=true, que
-- acha a loja pelo instance_name) segue funcionando.
insert into config_global (chave, valor, atualizado_em)
select 'backup_cloud_loja_numero_fwc_20260911',
       jsonb_build_object(
         'empresa_id', w.empresa_id,
         'cloud_phone_number_id', w.cloud_phone_number_id,
         'cloud_display_number', w.cloud_display_number,
         'cloud_waba_id', w.cloud_waba_id,
         'cloud_verified_name', w.cloud_verified_name,
         'cloud_pin', w.cloud_pin,
         'ia_ativo', w.ia_ativo
       )::text,
       now()
  from whatsapp_config w
  join config_global c on c.chave = 'admin_cloud_phone_number_id' and c.valor = w.cloud_phone_number_id
on conflict (chave) do nothing;

update whatsapp_config w
   set cloud_phone_number_id = null,
       cloud_display_number  = null,
       cloud_waba_id         = null,
       cloud_verified_name   = null,
       cloud_pin             = null
  from config_global c
 where c.chave = 'admin_cloud_phone_number_id'
   and c.valor = w.cloud_phone_number_id;
