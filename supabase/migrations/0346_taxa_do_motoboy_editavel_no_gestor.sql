-- Dono edita a taxa do motoboy pelo gestor (18/10/2026).
--
-- A mig 0345 deixava o motoboy e o admin/vendedor da loja gravar o valor da corrida. Agora o
-- gestor tem o botão pra isso (sem depender do motoboy), e quem usa o gestor às vezes é o
-- super_admin entrando na loja: ele também precisa poder gravar. Mesma regra de antes: nunca
-- depois de paga, e a edição do dono fica registrada como 'dono'.

create or replace function public.entregador_valor_sugerido(p_pedido uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_ped    record;
  v_perfil text;
  v_emp    uuid;
  v_valor  numeric;
  v_km     numeric;
begin
  if v_uid is null then return null; end if;
  select empresa_id, endereco_lat, endereco_lng, coalesce(tipo_entrega, 'entrega') as tipo
    into v_ped from pedidos_delivery where id = p_pedido;
  if not found or v_ped.tipo <> 'entrega' then return null; end if;

  select perfil, empresa_id into v_perfil, v_emp from profiles where id = v_uid;
  if v_perfil is distinct from 'super_admin'
     and (v_emp is distinct from v_ped.empresa_id or v_perfil not in ('entregador', 'admin', 'vendedor')) then
    return null;
  end if;

  select valor, km into v_valor, v_km from calcular_valor_entregador(v_ped.empresa_id, v_ped.endereco_lat, v_ped.endereco_lng);
  return v_valor;
end;
$$;

grant execute on function public.entregador_valor_sugerido(uuid) to authenticated;

create or replace function public.entregador_informar_valor(p_pedido uuid, p_valor numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_ped    record;
  v_perfil text;
  v_emp    uuid;
  v_calc   numeric;
  v_km     numeric;
  v_origem text;
  v_valor  numeric := round(p_valor, 2);
begin
  if v_uid is null then raise exception 'Não autenticado'; end if;
  if p_valor is null or p_valor < 0 or p_valor > 500 then
    raise exception 'Valor inválido: informe entre R$ 0,00 e R$ 500,00';
  end if;

  select id, empresa_id, entregador_id, endereco_lat, endereco_lng, endereco_bairro,
         coalesce(entregador_pago, false) as pago
    into v_ped from pedidos_delivery where id = p_pedido;
  if not found then raise exception 'Pedido não encontrado'; end if;

  select perfil, empresa_id into v_perfil, v_emp from profiles where id = v_uid;
  if v_perfil is distinct from 'super_admin'
     and (v_emp is distinct from v_ped.empresa_id or v_perfil not in ('entregador', 'admin', 'vendedor')) then
    raise exception 'Sem permissão';
  end if;
  if v_perfil = 'entregador' and v_ped.entregador_id is distinct from v_uid then
    raise exception 'Esta entrega não é sua';
  end if;
  if not exists (select 1 from empresas where id = v_ped.empresa_id and entregador_digita_valor) then
    raise exception 'Esta loja não usa valor do entregador';
  end if;
  if v_ped.pago then
    raise exception 'Entrega já paga: o valor não pode mais mudar';
  end if;

  select valor, km into v_calc, v_km from calcular_valor_entregador(v_ped.empresa_id, v_ped.endereco_lat, v_ped.endereco_lng);

  v_origem := case
    when v_calc is not null and abs(v_valor - v_calc) < 0.005 then 'calculado'
    when v_perfil = 'entregador' then 'motoboy'
    else 'dono'
  end;

  update pedidos_delivery
     set valor_entregador = v_valor,
         valor_entregador_calculado = v_calc,
         valor_entregador_origem = v_origem
   where id = p_pedido;

  delete from entregador_valor_ajustes where pedido_id = p_pedido;
  if v_origem <> 'calculado' then
    insert into entregador_valor_ajustes
      (empresa_id, pedido_id, entregador_id, editado_por, editado_por_perfil,
       valor_calculado, valor_final, distancia_km, bairro, lat, lng)
    values
      (v_ped.empresa_id, p_pedido, v_ped.entregador_id, v_uid, case when v_perfil = 'entregador' then 'entregador' else 'dono' end,
       v_calc, v_valor, v_km, v_ped.endereco_bairro, v_ped.endereco_lat, v_ped.endereco_lng);
  end if;
end;
$$;
