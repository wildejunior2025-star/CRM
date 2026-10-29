-- MOTOBOY RECEBE PELO KM DA RUA, IGUAL AO CLIENTE (29/10/2026)
--
-- Wilde: "3 km às vezes dava 5 quando o motoqueiro tava no caminho". O cliente
-- já paga pelo caminho da moto (migs 0421/0423) com o km arredondado pra meia
-- faixa mais perto (0425). O motoboy do iFood ainda era pago pela LINHA RETA
-- (calcular_valor_entregador) — no endereço do Wilde, 2 km na reta e 3,1 pela
-- rua. Agora os dois usam o mesmo km e a mesma tabela da loja.
--
-- O km pela rua do pedido do iFood é medido quando o pedido chega
-- (ifood-integration, Google Routes, mesmo cache do link) e fica em km_rua.
-- Pedido sem km_rua (antes desta mig, ou o Google não respondeu) segue na
-- linha reta, como era.

alter table public.pedidos_delivery add column if not exists km_rua numeric;

comment on column public.pedidos_delivery.km_rua is
  'Km pelo caminho da moto, da loja até o pino do cliente (Google Routes). Base do valor do motoboy (mig 0427).';

-- Valor da tabela de km da loja pra ESTE pedido: km da rua se tiver, senão
-- linha reta. Mesmo arredondamento do link (meia faixa mais perto).
create or replace function public.valor_km_do_pedido(p_pedido uuid, out valor numeric, out km numeric)
returns record
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_ped record;
  v_faixas jsonb;
  v_km numeric;
begin
  valor := null; km := null;
  select p.empresa_id, p.endereco_lat, p.endereco_lng, p.km_rua, e.taxas_entrega_km
    into v_ped
    from pedidos_delivery p join empresas e on e.id = p.empresa_id
   where p.id = p_pedido;
  if not found then return; end if;

  if v_ped.km_rua is null then
    select c.valor, c.km into valor, km
      from calcular_valor_entregador(v_ped.empresa_id, v_ped.endereco_lat, v_ped.endereco_lng) c;
    return;
  end if;

  v_faixas := coalesce(v_ped.taxas_entrega_km, '[]'::jsonb);
  if jsonb_array_length(v_faixas) = 0 then return; end if;
  km := round(v_ped.km_rua, 2);
  v_km := round(v_ped.km_rua * 2) / 2;
  select round((f->>'taxa')::numeric, 2) into valor
    from jsonb_array_elements(v_faixas) f
   where v_km <= (f->>'km')::numeric
   order by (f->>'km')::numeric limit 1;
  if valor is null then
    select round((f->>'taxa')::numeric, 2) into valor
      from jsonb_array_elements(v_faixas) f
     order by (f->>'km')::numeric desc limit 1;
  end if;
end;
$$;

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

  select valor into v_km from valor_km_do_pedido(p_pedido);
  return v_km;
end;
$$;

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
    select valor into v_km from valor_km_do_pedido(NEW.id);

    if v_valor is not null then
      NEW.valor_entregador := v_valor;
      NEW.valor_entregador_calculado := v_km;
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
