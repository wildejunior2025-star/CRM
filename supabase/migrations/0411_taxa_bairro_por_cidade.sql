-- Bairro com o mesmo nome em duas cidades (27/10/2026)
--
-- A CDBom (São Gonçalo do Amarante) entrega no "Jardins" de São Gonçalo (R$ 7)
-- e no "Jardins" de Extremoz (R$ 15). A tabela de bairros só tinha nome, então
-- o pedido #1544 (Jardins, Extremoz) casou com o Jardins de São Gonçalo e saiu
-- a R$ 7. O #1490 (R$ 8) e os "Centro" de Extremoz (#1359, #1291) idem.
--
-- A regra nova: BAIRRO SEM CIDADE NO NOME É BAIRRO DA CIDADE DA LOJA. Quando o
-- endereço é de OUTRA cidade, antes do casamento por nome de sempre:
--   1) procura "<bairro> de <cidade>" cadastrado ("Jardins de Extremoz");
--   2) senão, a linha com o nome da cidade ("Extremoz" = taxa da cidade toda).
-- Não achou nenhum dos dois → segue o caminho antigo, igual a hoje.
--
-- Endereço na cidade da loja (ou sem cidade) não muda nada. Em 27/10 só a
-- CDBom tinha linha com nome de cidade usada em pedido (Extremoz).
--
-- A mesma regra está no checkout (DeliveryCheckout), no Painel de Pedidos e no
-- robô do WhatsApp — as réguas têm que bater, senão a trava recusa pedido certo.

-- Tira "de/do/da/dos/das": "Jardins de Extremoz" e "Jardins Extremoz" são o mesmo.
create or replace function public.norm_bairro_sem_conectivo(p_txt text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(coalesce(public.norm_bairro(p_txt), ''), '\m(de|do|da|dos|das)\M', ' ', 'g'),
           '\s+', ' ', 'g')), '');
$$;

drop function if exists public.taxa_entrega_esperada(uuid, text, double precision, double precision);

create or replace function public.taxa_entrega_esperada(
  p_empresa uuid,
  p_bairro  text,
  p_lat     double precision,
  p_lng     double precision,
  p_cidade  text default null
)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_emp  record;
  v_cfg  jsonb;
  v_n    text;
  v_cid  text;
  v_cidl text;
  v_taxa numeric;
  v_dist numeric;
begin
  select taxa_entrega, taxas_entrega_km, taxas_entrega_bairro, latitude, longitude, cidade
    into v_emp from public.empresas where id = p_empresa;
  if not found then return null; end if;

  v_n    := public.norm_bairro(p_bairro);
  v_cid  := public.norm_bairro_sem_conectivo(p_cidade);
  v_cidl := public.norm_bairro_sem_conectivo(v_emp.cidade);

  -- 0) Endereço de OUTRA cidade ("Sao Goncalo" e "Sao Goncalo do Amarante" contam
  --    como a mesma): "<bairro> de <cidade>" e depois a linha da cidade.
  if v_cid is not null and length(v_cid) >= 3
     and (v_cidl is null or (strpos(v_cid, v_cidl) = 0 and strpos(v_cidl, v_cid) = 0)) then
    if v_n is not null then
      select c.b into v_cfg from (
        select b, public.norm_bairro_sem_conectivo(b->>'bairro') as nome, ord
          from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro,'[]'::jsonb))
               with ordinality as t(b, ord)) c
       where c.nome = public.norm_bairro_sem_conectivo(p_bairro || ' ' || p_cidade)
       order by c.ord limit 1;
    end if;
    if v_cfg is null then
      select c.b into v_cfg from (
        select b, public.norm_bairro_sem_conectivo(b->>'bairro') as nome, ord
          from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro,'[]'::jsonb))
               with ordinality as t(b, ord)) c
       where c.nome = v_cid
       order by c.ord limit 1;
    end if;
    if v_cfg is not null then
      if coalesce(v_cfg->>'entrega','true') = 'false' then return null; end if;
      return round(coalesce(nullif(v_cfg->>'taxa','')::numeric, 0), 2);
    end if;
  end if;

  if v_n is not null then
    -- 1a) nome igual
    select c.b into v_cfg from (
      select b, public.norm_bairro(b->>'bairro') as nome, ord
        from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro,'[]'::jsonb))
             with ordinality as t(b, ord)) c
     where c.nome = v_n order by c.ord limit 1;
    -- 1b) o nome cadastrado aparece dentro do que o cliente escreveu (vence o mais específico)
    if v_cfg is null then
      select c.b into v_cfg from (
        select b, public.norm_bairro(b->>'bairro') as nome, ord
          from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro,'[]'::jsonb))
               with ordinality as t(b, ord)) c
       where c.nome is not null and length(c.nome) >= 3 and strpos(v_n, c.nome) > 0
       order by length(c.nome) desc, c.ord limit 1;
    end if;
    -- 1c) o que o cliente escreveu aparece dentro do nome cadastrado (vence o menos específico)
    if v_cfg is null then
      select c.b into v_cfg from (
        select b, public.norm_bairro(b->>'bairro') as nome, ord
          from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro,'[]'::jsonb))
               with ordinality as t(b, ord)) c
       where c.nome is not null and length(v_n) >= 3 and strpos(c.nome, v_n) > 0
       order by length(c.nome) asc, c.ord limit 1;
    end if;

    if v_cfg is not null then
      if coalesce(v_cfg->>'entrega','true') = 'false' then return null; end if;
      return round(coalesce(nullif(v_cfg->>'taxa','')::numeric, 0), 2);
    end if;
  end if;

  if jsonb_array_length(coalesce(v_emp.taxas_entrega_km, '[]'::jsonb)) > 0 then
    if p_lat is not null and p_lng is not null
       and v_emp.latitude is not null and v_emp.longitude is not null then
      v_dist := 6371 * acos(least(1, greatest(-1,
                  cos(radians(v_emp.latitude::double precision)) * cos(radians(p_lat))
                    * cos(radians(p_lng) - radians(v_emp.longitude::double precision))
                  + sin(radians(v_emp.latitude::double precision)) * sin(radians(p_lat)))));
      select round((f->>'taxa')::numeric, 2) into v_taxa
        from jsonb_array_elements(v_emp.taxas_entrega_km) f
       where v_dist <= (f->>'km')::numeric
       order by (f->>'km')::numeric limit 1;
      if v_taxa is null then
        select round((f->>'taxa')::numeric, 2) into v_taxa
          from jsonb_array_elements(v_emp.taxas_entrega_km) f
         order by (f->>'km')::numeric desc limit 1;
      end if;
      return v_taxa;
    end if;
    select round(min((f->>'taxa')::numeric), 2) into v_taxa
      from jsonb_array_elements(v_emp.taxas_entrega_km) f;
    return v_taxa;
  end if;

  return round(coalesce(v_emp.taxa_entrega, 0), 2);
end;
$$;

grant execute on function public.norm_bairro_sem_conectivo(text) to anon, authenticated, service_role;
grant execute on function public.taxa_entrega_esperada(uuid, text, double precision, double precision, text) to anon, authenticated, service_role;

-- A trava passa a mandar a cidade do pedido.
create or replace function public.validar_taxa_entrega_pedido()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_esperada numeric;
begin
  if NEW.tipo_entrega is distinct from 'entrega' then
    return NEW;
  end if;
  -- Só o que nasce no aparelho do cliente. O pedido do balcão, do WhatsApp e do
  -- iFood tem uma pessoa da loja (ou o contrato do iFood) decidindo a taxa —
  -- inclusive zerar, que é promoção legítima e acontece toda semana.
  if coalesce(NEW.origem, 'cardapio') not in ('cardapio', 'app') then
    return NEW;
  end if;

  v_esperada := public.taxa_entrega_esperada(
    NEW.empresa_id, NEW.endereco_bairro, NEW.endereco_lat, NEW.endereco_lng, NEW.endereco_cidade);

  -- Sem saber a taxa certa, não recusa nada. Taxa certa ZERO também passa:
  -- tem loja que não cobra entrega, e isso não é erro.
  if v_esperada is null or v_esperada <= 0 then
    return NEW;
  end if;

  -- A margem de 1 centavo é pro arredondamento; o que ela protege de verdade é
  -- a taxa que veio MENOR que a devida. Maior passa: cliente que aceitou pagar
  -- mais (bairro caro cadastrado depois, pino além da última faixa) não tem
  -- por que ter o pedido recusado.
  if coalesce(NEW.taxa_entrega, 0) < v_esperada - 0.009 then
    raise exception
      'A taxa de entrega deste pedido não confere (veio R$ %, o certo é R$ %). Atualize a página e faça o pedido de novo.',
      to_char(coalesce(NEW.taxa_entrega, 0), 'FM999990.00'),
      to_char(v_esperada, 'FM999990.00');
  end if;

  return NEW;
end;
$$;
