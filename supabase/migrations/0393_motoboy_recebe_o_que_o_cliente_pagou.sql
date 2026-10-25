-- O MOTOBOY RECEBE A TAXA QUE O CLIENTE PAGOU (25/10/2026)
--
-- Ate aqui, quando a entrega era concluida sem ninguem digitar valor, um
-- gatilho gravava o calculo da TABELA DE KM por cima — e a taxa que o cliente
-- realmente pagou naquele pedido nem era consultada.
--
-- O estrago era silencioso e grande. Pedido #1177 do Mickey: cliente pagou
-- R$ 5,00 de entrega, a tabela dizia R$ 4,00 pra 1,14 km, e o app do motoboy
-- mostrava R$ 4,00. Ele so recebeu os R$ 5,00 porque editou na mao. Medindo a
-- base inteira: no Zebu, 374 corridas pagaram menos que a taxa cobrada, somando
-- R$ 1.052,33 de diferenca que ninguem decidiu reter.
--
-- Agrava que o km e medido em LINHA RETA (haversine), nao pela rua: o caminho
-- real e sempre maior, entao a tabela sempre paga a menos.
--
-- Regra nova, decidida pelo dono: o motoboy recebe o que o cliente pagou, menos
-- o desconto que a loja combinou com ELE (que continua existindo e e explicito).
-- A tabela de km vira RESERVA — so entra quando o pedido nao tem taxa (entrega
-- gratis, promocao do iFood que zera a taxa). O valor segue editavel.

-- 'taxa' e a origem nova: o valor veio da taxa do pedido, nao de calculo.
alter table pedidos_delivery drop constraint if exists pedidos_delivery_valor_entregador_origem_check;
alter table pedidos_delivery add constraint pedidos_delivery_valor_entregador_origem_check
  check (valor_entregador_origem is null
         or valor_entregador_origem = any (array['calculado','taxa','motoboy','dono']));

-- Quanto esta corrida vale pra ESTE entregador: taxa do pedido menos o desconto
-- combinado com ele. Sem taxa, cai na tabela de km.
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

  if coalesce(v_ped.taxa_entrega, 0) > 0 then
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
  'O que o motoboy recebe: taxa paga pelo cliente menos o desconto combinado com ele. Tabela de km so quando o pedido nao tem taxa.';

-- A sugestao que o app e o gestor mostram passa a sair da mesma regra.
create or replace function public.entregador_valor_sugerido(p_pedido uuid)
returns numeric
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_uid    uuid := auth.uid();
  v_ped    record;
  v_perfil text;
  v_emp    uuid;
begin
  if v_uid is null then return null; end if;
  select empresa_id, entregador_id, coalesce(tipo_entrega,'entrega') as tipo
    into v_ped from pedidos_delivery where id = p_pedido;
  if not found or v_ped.tipo <> 'entrega' then return null; end if;

  select perfil, empresa_id into v_perfil, v_emp from profiles where id = v_uid;
  if v_perfil is distinct from 'super_admin'
     and (v_emp is distinct from v_ped.empresa_id or v_perfil not in ('entregador','admin','vendedor')) then
    return null;
  end if;

  -- O desconto e de quem FAZ a corrida. Dono abrindo a tela do motoboy ve o
  -- numero dele, nao um calculado com o proprio perfil.
  return valor_da_corrida(p_pedido, coalesce(v_ped.entregador_id, v_uid));
end;
$$;

-- Conclusao da entrega sem valor digitado: grava a taxa, nao o km.
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
    -- O km continua guardado como REFERENCIA: e o que a tela mostra quando
    -- alguem edita ("o sistema calculou R$ x"), e e como a gente descobre que
    -- a tabela de km esta fora da realidade.
    select valor into v_km from calcular_valor_entregador(NEW.empresa_id, NEW.endereco_lat, NEW.endereco_lng);

    if v_valor is not null then
      NEW.valor_entregador := v_valor;
      NEW.valor_entregador_calculado := v_km;
      NEW.valor_entregador_origem := case when coalesce(NEW.taxa_entrega,0) > 0 then 'taxa' else 'calculado' end;
    end if;
  end if;
  return NEW;
end;
$$;
