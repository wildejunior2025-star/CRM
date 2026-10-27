-- PEDIDO DO IFOOD: O MOTOBOY RECEBE PELA TABELA DE KM (27/10/2026)
--
-- A mig 0393 fez o motoboy receber a taxa que o CLIENTE pagou. No iFood isso
-- não existe: o "R$ 6,99" que chega na taxa_entrega é o frete que o iFood paga
-- à LOJA (promoção Hits), igual pra qualquer endereço. Resultado no Zebu, de
-- 26 a 27/10: 67 corridas do iFood lançadas a R$ 6,99 cada (R$ 472,86) quando
-- a tabela de km da loja dava R$ 272 — corrida de 30 metros pagando 6,99.
--
-- Regra do dono: endereço que vem do iFood é calculado pelo NOSSO sistema
-- (tabela de km da loja). A taxa do pedido só vale pros canais da própria loja.

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

  if coalesce(v_ped.taxa_entrega, 0) > 0 and v_ped.origem is distinct from 'ifood' then
    select entregador_desconto_ativo, entregador_desconto_valor, entregador_desconto_tipo,
           entregador_desconto_loja_ativo, entregador_desconto_loja_valor, entregador_desconto_loja_tipo
      into v_perf from profiles where id = p_entregador;
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
  'O que o motoboy recebe: taxa paga pelo cliente menos o desconto combinado com ele. Tabela de km quando o pedido não tem taxa ou é do iFood (mig 0412).';

-- A origem gravada acompanha: corrida do iFood é 'calculado', não 'taxa'.
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
      NEW.valor_entregador_origem := case
        when coalesce(NEW.taxa_entrega,0) > 0 and NEW.origem is distinct from 'ifood' then 'taxa'
        else 'calculado' end;
    end if;
  end if;
  return NEW;
end;
$$;
