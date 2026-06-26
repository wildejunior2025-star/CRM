-- Chat da LOJA ONLINE: o cliente compra sem login (anon), identificado pelo telefone.
-- Como não há auth.uid(), o acesso à caixa de mensagens é feito por funções
-- SECURITY DEFINER que filtram sempre por (empresa_id, canal='lojaonline', telefone).
-- Mesmo padrão de segurança já usado em buscar_cliente_loja / upsert_cliente_loja (0045).
-- NÃO mexe no robô/WhatsApp.

-- Normaliza telefone para só dígitos (consistente com o cliente_ref guardado).
-- Lista a conversa da loja online (cliente + loja) por empresa e telefone.
create or replace function listar_msgs_loja(p_empresa_id uuid, p_telefone text)
returns setof public.mensagens_chat
language sql security definer set search_path = public as $$
  select *
  from public.mensagens_chat
  where empresa_id = p_empresa_id
    and canal = 'lojaonline'
    and cliente_ref = regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g')
  order by created_at asc
  limit 300;
$$;

-- Cliente da loja online manda mensagem (remetente = cliente).
create or replace function enviar_msg_loja(
  p_empresa_id uuid, p_telefone text, p_nome text, p_texto text
) returns public.mensagens_chat
language plpgsql security definer set search_path = public as $$
declare
  v_ref text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  r public.mensagens_chat;
begin
  if coalesce(btrim(p_texto), '') = '' then
    raise exception 'Mensagem vazia';
  end if;
  if v_ref = '' then
    raise exception 'Telefone obrigatório';
  end if;
  insert into public.mensagens_chat
    (empresa_id, canal, cliente_ref, cliente_nome, remetente, texto, lida_cliente)
  values
    (p_empresa_id, 'lojaonline', v_ref, nullif(btrim(p_nome), ''), 'cliente', btrim(p_texto), true)
  returning * into r;
  return r;
end; $$;

-- Marca como lidas (pelo cliente) as mensagens que a loja enviou nesta conversa.
create or replace function marcar_lidas_loja(p_empresa_id uuid, p_telefone text)
returns void
language sql security definer set search_path = public as $$
  update public.mensagens_chat
  set lida_cliente = true
  where empresa_id = p_empresa_id
    and canal = 'lojaonline'
    and cliente_ref = regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g')
    and remetente = 'loja'
    and lida_cliente = false;
$$;

revoke execute on function listar_msgs_loja(uuid, text) from public;
grant  execute on function listar_msgs_loja(uuid, text) to anon, authenticated;
revoke execute on function enviar_msg_loja(uuid, text, text, text) from public;
grant  execute on function enviar_msg_loja(uuid, text, text, text) to anon, authenticated;
revoke execute on function marcar_lidas_loja(uuid, text) from public;
grant  execute on function marcar_lidas_loja(uuid, text) to anon, authenticated;
