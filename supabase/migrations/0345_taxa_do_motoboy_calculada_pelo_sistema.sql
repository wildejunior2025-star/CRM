-- Taxa do motoboy CALCULADA pelo sistema, com edição registrada (18/10/2026) — só Zebu (teste).
--
-- Na mig 0344 o motoboy digitava o valor de cada corrida. Agora o sistema calcula pela tabela
-- de km que a loja já tem (distância em linha reta da loja até o ponto da entrega) e o motoboy
-- só EDITA quando não bate. Cada edição fica registrada em `entregador_valor_ajustes`: o dono vê
-- que foi editado e a gente usa o histórico pra melhorar o cálculo (bairro, rua, km de estrada).
--
-- Se ninguém mexer, ao concluir a entrega o valor calculado é gravado sozinho (gatilho) — vale
-- também quando a loja conclui pelo gestor e o motoboy nunca abriu o app.

alter table public.pedidos_delivery
  add column if not exists valor_entregador_calculado numeric(10,2),
  add column if not exists valor_entregador_origem text
    check (valor_entregador_origem is null or valor_entregador_origem in ('calculado', 'motoboy', 'dono'));

comment on column public.pedidos_delivery.valor_entregador_calculado is
  'O que o sistema calculou (tabela de km da loja) pra esta corrida. Fica guardado mesmo quando o motoboy edita.';
comment on column public.pedidos_delivery.valor_entregador_origem is
  'De onde veio valor_entregador: calculado pelo sistema, editado pelo motoboy ou editado pelo dono.';

-- ── Onde ficam as edições (aprender com elas) ───────────────────────────────
create table if not exists public.entregador_valor_ajustes (
  id                 uuid primary key default gen_random_uuid(),
  empresa_id         uuid not null references public.empresas(id) on delete cascade,
  pedido_id          uuid not null references public.pedidos_delivery(id) on delete cascade,
  entregador_id      uuid references public.profiles(id) on delete set null,
  editado_por        uuid references public.profiles(id) on delete set null,
  editado_por_perfil text,
  valor_calculado    numeric(10,2),          -- null = o sistema não conseguiu calcular (sem ponto/tabela)
  valor_final        numeric(10,2) not null,
  distancia_km       numeric(6,2),
  bairro             text,
  lat                double precision,
  lng                double precision,
  created_at         timestamptz not null default now(),
  unique (pedido_id)                          -- vale a última edição daquela corrida
);

create index if not exists idx_valor_ajustes_empresa on public.entregador_valor_ajustes (empresa_id, created_at desc);

alter table public.entregador_valor_ajustes enable row level security;

drop policy if exists "loja ve os ajustes do motoboy" on public.entregador_valor_ajustes;
create policy "loja ve os ajustes do motoboy" on public.entregador_valor_ajustes
  for select using (
    empresa_id = current_empresa_id()
    and current_perfil() in ('admin', 'vendedor')
  );

drop policy if exists "super admin ve todos os ajustes" on public.entregador_valor_ajustes;
create policy "super admin ve todos os ajustes" on public.entregador_valor_ajustes
  for select using (current_perfil() = 'super_admin');

-- ── O cálculo: tabela de km da loja ─────────────────────────────────────────
-- Linha reta (haversine), igual ao resto do sistema. Mais longe que a última faixa: vale a última.
-- Devolve NULL (valor) quando não dá pra calcular: sem ponto, sem tabela de km ou loja sem endereço.
create or replace function public.calcular_valor_entregador(
  p_empresa uuid,
  p_lat double precision,
  p_lng double precision,
  out valor numeric,
  out km numeric
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_emp record;
begin
  valor := null;
  km := null;
  if p_lat is null or p_lng is null then return; end if;

  select latitude, longitude, taxas_entrega_km into v_emp from empresas where id = p_empresa;
  if not found
     or v_emp.latitude is null or v_emp.longitude is null
     or jsonb_array_length(coalesce(v_emp.taxas_entrega_km, '[]'::jsonb)) = 0 then
    return;
  end if;

  km := round((6371 * acos(least(1, greatest(-1,
          cos(radians(v_emp.latitude::double precision)) * cos(radians(p_lat))
            * cos(radians(p_lng) - radians(v_emp.longitude::double precision))
          + sin(radians(v_emp.latitude::double precision)) * sin(radians(p_lat))))))::numeric, 2);

  select round((f->>'taxa')::numeric, 2) into valor
    from jsonb_array_elements(v_emp.taxas_entrega_km) f
   where km <= (f->>'km')::numeric
   order by (f->>'km')::numeric
   limit 1;

  if valor is null then
    select round((f->>'taxa')::numeric, 2) into valor
      from jsonb_array_elements(v_emp.taxas_entrega_km) f
     order by (f->>'km')::numeric desc
     limit 1;
  end if;
end;
$$;

-- O app do motoboy pergunta o valor calculado de UMA corrida (mostra no botão roxo).
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
  if v_emp is distinct from v_ped.empresa_id or v_perfil not in ('entregador', 'admin', 'vendedor') then
    return null;
  end if;

  select valor, km into v_valor, v_km from calcular_valor_entregador(v_ped.empresa_id, v_ped.endereco_lat, v_ped.endereco_lng);
  return v_valor;
end;
$$;

grant execute on function public.entregador_valor_sugerido(uuid) to authenticated;

-- ── Gravar/editar o valor: agora registra a origem e a edição ───────────────
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
  if v_emp is distinct from v_ped.empresa_id or v_perfil not in ('entregador', 'admin', 'vendedor') then
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

  -- Registro das edições. Voltou pro valor calculado? Some do registro (vale o estado final).
  delete from entregador_valor_ajustes where pedido_id = p_pedido;
  if v_origem <> 'calculado' then
    insert into entregador_valor_ajustes
      (empresa_id, pedido_id, entregador_id, editado_por, editado_por_perfil,
       valor_calculado, valor_final, distancia_km, bairro, lat, lng)
    values
      (v_ped.empresa_id, p_pedido, v_ped.entregador_id, v_uid, v_perfil,
       v_calc, v_valor, v_km, v_ped.endereco_bairro, v_ped.endereco_lat, v_ped.endereco_lng);
  end if;
end;
$$;

-- ── Ninguém editou? Ao concluir a entrega o valor calculado vira o valor da corrida ──
create or replace function public.trg_valor_entregador_auto()
returns trigger
language plpgsql
security definer
set search_path = public
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
    select valor, km into v_valor, v_km from calcular_valor_entregador(NEW.empresa_id, NEW.endereco_lat, NEW.endereco_lng);
    if v_valor is not null then
      NEW.valor_entregador := v_valor;
      NEW.valor_entregador_calculado := v_valor;
      NEW.valor_entregador_origem := 'calculado';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_valor_entregador_auto on public.pedidos_delivery;
create trigger trg_valor_entregador_auto
  before update of status on public.pedidos_delivery
  for each row execute function public.trg_valor_entregador_auto();
