-- IFOOD PELO KM VIRA BOTÃO POR MOTOBOY (27/10/2026)
--
-- A mig 0412 mandou TODA corrida do iFood pra tabela de km. O dono quer
-- escolher por motoboy: quem tem o botão ligado recebe a corrida do iFood
-- pela tabela de km da loja (a "taxa da casa"); quem não tem segue recebendo
-- a taxa que veio do iFood, como na mig 0393.
--
-- Os motoboys do Zebu nascem ligados — foi o pedido que originou isto (o
-- R$ 6,99 do iFood pago numa corrida de 30 metros).

alter table public.profiles
  add column if not exists entregador_ifood_pelo_km boolean not null default false;

comment on column public.profiles.entregador_ifood_pelo_km is
  'Corrida do iFood paga pela tabela de km da loja em vez da taxa que veio do iFood (mig 0413).';

update public.profiles set entregador_ifood_pelo_km = true
 where perfil = 'entregador'
   and empresa_id = '8086398c-04e5-4ba4-927a-936edf15cc20';  -- Zebu Restaurante

create or replace function public.valor_da_corrida(p_pedido uuid, p_entregador uuid)
returns numeric
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_ped  record;
  v_perf record;
  v_desc numeric;
  v_km   numeric;
begin
  select empresa_id, origem, taxa_entrega, endereco_lat, endereco_lng,
         coalesce(tipo_entrega,'entrega') as tipo
    into v_ped from pedidos_delivery where id = p_pedido;
  if not found or v_ped.tipo <> 'entrega' then return null; end if;

  select entregador_desconto_ativo, entregador_desconto_valor, entregador_desconto_tipo,
         entregador_desconto_loja_ativo, entregador_desconto_loja_valor, entregador_desconto_loja_tipo,
         entregador_ifood_pelo_km
    into v_perf from profiles where id = p_entregador;

  if coalesce(v_ped.taxa_entrega, 0) > 0
     and not (v_ped.origem = 'ifood' and coalesce(v_perf.entregador_ifood_pelo_km, false)) then
    v_desc := coalesce(desconto_entrega(v_ped.origem, v_ped.taxa_entrega,
                v_perf.entregador_desconto_ativo, v_perf.entregador_desconto_valor, v_perf.entregador_desconto_tipo,
                v_perf.entregador_desconto_loja_ativo, v_perf.entregador_desconto_loja_valor, v_perf.entregador_desconto_loja_tipo), 0);
    return greatest(0, round(v_ped.taxa_entrega - v_desc, 2));
  end if;

  select valor into v_km from calcular_valor_entregador(v_ped.empresa_id, v_ped.endereco_lat, v_ped.endereco_lng);
  return v_km;
end;
$$;

comment on function public.valor_da_corrida(uuid, uuid) is
  'O que o motoboy recebe: taxa do pedido menos o desconto combinado com ele. Tabela de km quando o pedido não tem taxa, ou é do iFood e o motoboy tem entregador_ifood_pelo_km (mig 0413).';

create or replace function public.trg_valor_entregador_auto()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_valor numeric;
  v_km    numeric;
begin
  if NEW.status = 'entregue'
     and OLD.status is distinct from 'entregue'
     and NEW.valor_entregador is null
     and NEW.entregador_id is not null
     and coalesce(NEW.tipo_entrega, 'entrega') = 'entrega'
     and exists (select 1 from empresas where id = NEW.empresa_id and entregador_digita_valor) then

    v_valor := valor_da_corrida(NEW.id, NEW.entregador_id);
    select valor into v_km from calcular_valor_entregador(NEW.empresa_id, NEW.endereco_lat, NEW.endereco_lng);

    if v_valor is not null then
      NEW.valor_entregador := v_valor;
      NEW.valor_entregador_calculado := v_km;
      -- 'taxa' só quando o valor saiu mesmo da taxa do pedido
      NEW.valor_entregador_origem := case
        when coalesce(NEW.taxa_entrega,0) > 0
             and not (NEW.origem = 'ifood'
                      and coalesce((select entregador_ifood_pelo_km from profiles where id = NEW.entregador_id), false))
          then 'taxa'
        else 'calculado' end;
    end if;
  end if;
  return NEW;
end;
$$;
