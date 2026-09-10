-- =========================================================
-- Migration 0254 - Amarra o link do mapa ao pedido depois que ele nasce
-- =========================================================
-- O link pedido pelo CHAT é gerado antes do pedido existir (a sacola ainda está
-- sendo montada), então ele nasce sem pedido_id. Sem isso, o cliente arrastar o
-- pino depois só corrigia o cadastro dele — o pedido que já estava na rua seguia
-- com o ponto velho. A loja não tem UPDATE em pin_links (só SELECT), por isso a
-- correção vem por função.
-- =========================================================
create or replace function public.amarrar_pin_link_ao_pedido(p_token uuid, p_pedido_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_emp uuid := current_empresa_id();
begin
  if v_emp is null then
    return json_build_object('ok', false, 'erro', 'Sem empresa.');
  end if;

  update pin_links
     set pedido_id = p_pedido_id
   where token = p_token
     and empresa_id = v_emp;

  if not found then
    return json_build_object('ok', false, 'erro', 'Link não encontrado.');
  end if;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.amarrar_pin_link_ao_pedido(uuid, uuid) to authenticated;
