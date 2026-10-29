-- Wilde, 28/10/2026: "3 km e 3 km e ponto final". Sem divisao na rua, e o km
-- arredonda pra MEIA FAIXA MAIS PERTO: 2,7 cobra 2,5 e 2,8 cobra 3.
--
-- 1) Sai o ajuste da rua (0424): todo mundo volta pra 1, km exato da rua.
-- 2) A conferencia da taxa (PIX e insert do pedido) usa a mesma regra de
--    arredondamento do link. Sem isto, 2,6 km na reta arredondava PRA CIMA
--    (faixa de 3) e o link cobrava 2,5 pela rua: o banco recusaria o pedido.
--    Com as duas arredondando pro mais perto, rua >= reta garante taxa do link
--    >= taxa conferida.
update public.empresas set fator_rua = 1 where fator_rua <> 1;

CREATE OR REPLACE FUNCTION public.taxa_entrega_esperada(p_empresa uuid, p_bairro text, p_lat double precision, p_lng double precision, p_cidade text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
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
    select c.b into v_cfg from (
      select b, public.norm_bairro(b->>'bairro') as nome, ord
        from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro,'[]'::jsonb))
             with ordinality as t(b, ord)) c
     where c.nome = v_n order by c.ord limit 1;
    if v_cfg is null then
      select c.b into v_cfg from (
        select b, public.norm_bairro(b->>'bairro') as nome, ord
          from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro,'[]'::jsonb))
               with ordinality as t(b, ord)) c
       where c.nome is not null and length(c.nome) >= 3 and strpos(v_n, c.nome) > 0
       order by length(c.nome) desc, c.ord limit 1;
    end if;
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
      -- Meia faixa mais perto (0425): 2,7 -> 2,5 ; 2,8 -> 3. Igual ao link.
      v_dist := round(v_dist * 2) / 2;
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
$function$;
