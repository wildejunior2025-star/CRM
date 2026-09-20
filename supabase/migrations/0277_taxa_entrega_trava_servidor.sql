-- Trava de servidor pra taxa de entrega (20/09/2026)
--
-- O pedido #44 do Zebu fechou com ENTREGA GRÁTIS: R$ 17,00 de comida, R$ 0,00
-- de taxa, PIX pago, e a loja só descobriu na hora de imprimir. A conta da taxa
-- mora no navegador do cliente, e o celular dela ainda rodava o checkout de
-- julho — o de hoje nem deixaria fechar o pedido sem a taxa.
--
-- É esse o buraco: enquanto quem calcula o dinheiro é o aparelho do cliente,
-- basta um aparelho desatualizado (ou alguém mexendo no navegador) pra entrega
-- sair de graça. Aqui o banco passa a refazer a conta e recusar o que vier
-- abaixo dela. Vale só pros pedidos que nascem do lado do CLIENTE (Loja Online
-- e app): balcão, WhatsApp e iFood é a loja que decide, e loja pode dar
-- entrega de graça pra quem ela quiser.

create extension if not exists unaccent;

-- Bairro comparável — a MESMA régua do checkout (normBairro, em
-- DeliveryCheckout.jsx). Tem que dar o mesmo resultado dos dois lados, senão a
-- trava recusaria pedido certo: a loja cadastra "Nossa Sra. da Apresentação" e
-- o cliente escreve "Nossa Senhora da Apresentação".
create or replace function public.norm_bairro(p_txt text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(
    (select string_agg(
       case palavra
         when 'sra'  then 'senhora'     when 'sr'   then 'senhor'
         when 'sto'  then 'santo'       when 'sta'  then 'santa'
         when 'n'    then 'nossa'       when 'na'   then 'nossa'
         when 'jd'   then 'jardim'      when 'pq'   then 'parque'
         when 'vl'   then 'vila'        when 'cj'   then 'conjunto'
         when 'res'  then 'residencial' when 'pres' then 'presidente'
         else palavra
       end, ' ' order by ord)
       from unnest(string_to_array(
              -- Tudo que não é letra nem número vira espaço: ponto de "Sra.",
              -- vírgula, traço e principalmente o apóstrofo, que vem reto do
              -- teclado do computador e CURVO do celular. O checkout faz a
              -- mesma coisa (normBairro) — as duas réguas têm que bater, senão
              -- a trava recusaria pedido certo.
              regexp_replace(
                btrim(regexp_replace(lower(unaccent(coalesce(p_txt, ''))),
                                     '[^a-z0-9]+', ' ', 'g')),
                '^bairro ', ''),
              ' ')) with ordinality as t(palavra, ord)
      where palavra <> ''),
    '');
$$;

-- Quanto ESTA loja cobraria por esta entrega. Refaz o que o checkout faz:
-- bairro cadastrado manda; sem bairro, vale a tabela por km medida do ponto do
-- cliente; loja de taxa fixa devolve a taxa fixa.
--
-- Devolve NULL quando não dá pra afirmar nada — e NULL nunca recusa pedido.
create or replace function public.taxa_entrega_esperada(
  p_empresa uuid,
  p_bairro  text,
  p_lat     double precision,
  p_lng     double precision
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
  v_taxa numeric;
  v_dist numeric;
begin
  select taxa_entrega, taxas_entrega_km, taxas_entrega_bairro, latitude, longitude
    into v_emp
    from public.empresas
   where id = p_empresa;
  if not found then
    return null;
  end if;

  -- 1) Bairro cadastrado manda. É o número que o cliente viu na tela, e ele
  --    ignora a distância de propósito (bairro grande, taxa única).
  --
  --    As três camadas abaixo são as MESMAS do acharBairroCfg do checkout, na
  --    mesma ordem. Não é capricho: lá "Amarante" cadastrado casa com quem
  --    escreveu "Novo Amarante". Se aqui a busca fosse só por nome igual, a
  --    conta cairia na tabela por km, daria um número maior que o da tela e a
  --    trava recusaria pedido CERTO — o oposto do que ela existe pra fazer.
  v_n := public.norm_bairro(p_bairro);
  if v_n is not null then
    -- 1a) nome igual
    select c.b into v_cfg
      from (select b, public.norm_bairro(b->>'bairro') as nome, ord
              from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro, '[]'::jsonb))
                   with ordinality as t(b, ord)) c
     where c.nome = v_n
     order by c.ord
     limit 1;
    -- 1b) o nome cadastrado aparece dentro do que o cliente escreveu — ganha o
    --     MAIS específico, senão "Redinha" roubaria o endereço de "Redinha Nova"
    if v_cfg is null then
      select c.b into v_cfg
        from (select b, public.norm_bairro(b->>'bairro') as nome, ord
                from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro, '[]'::jsonb))
                     with ordinality as t(b, ord)) c
       where c.nome is not null and length(c.nome) >= 3 and strpos(v_n, c.nome) > 0
       order by length(c.nome) desc, c.ord
       limit 1;
    end if;
    -- 1c) o que o cliente escreveu aparece dentro do nome cadastrado
    if v_cfg is null then
      select c.b into v_cfg
        from (select b, public.norm_bairro(b->>'bairro') as nome, ord
                from jsonb_array_elements(coalesce(v_emp.taxas_entrega_bairro, '[]'::jsonb))
                     with ordinality as t(b, ord)) c
       where c.nome is not null and length(v_n) >= 3 and strpos(c.nome, v_n) > 0
       order by length(c.nome) asc, c.ord
       limit 1;
    end if;

    if v_cfg is not null then
      -- Bairro que a loja marcou como "não entrego": a trava não opina. Quem
      -- barra esse pedido é a tela, e recusar aqui por causa da TAXA seria
      -- responder a pergunta errada.
      if coalesce(v_cfg->>'entrega', 'true') = 'false' then
        return null;
      end if;
      return round(coalesce(nullif(v_cfg->>'taxa', '')::numeric, 0), 2);
    end if;
  end if;

  -- 2) Tabela por km.
  if jsonb_array_length(coalesce(v_emp.taxas_entrega_km, '[]'::jsonb)) > 0 then
    if p_lat is not null and p_lng is not null
       and v_emp.latitude is not null and v_emp.longitude is not null then
      -- Distância em linha reta, igual à do checkout (haversine).
      v_dist := 6371 * acos(least(1, greatest(-1,
                  cos(radians(v_emp.latitude::double precision)) * cos(radians(p_lat))
                    * cos(radians(p_lng) - radians(v_emp.longitude::double precision))
                  + sin(radians(v_emp.latitude::double precision)) * sin(radians(p_lat)))));
      select round((f->>'taxa')::numeric, 2)
        into v_taxa
        from jsonb_array_elements(v_emp.taxas_entrega_km) f
       where v_dist <= (f->>'km')::numeric
       order by (f->>'km')::numeric
       limit 1;
      -- Mais longe que a última faixa: vale a última (é o que o checkout faz).
      if v_taxa is null then
        select round((f->>'taxa')::numeric, 2)
          into v_taxa
          from jsonb_array_elements(v_emp.taxas_entrega_km) f
         order by (f->>'km')::numeric desc
         limit 1;
      end if;
      return v_taxa;
    end if;

    -- Sem o ponto no mapa não dá pra saber a distância — mas dá pra saber o
    -- CHÃO: ninguém paga menos que a faixa mais barata da tabela. Era esta a
    -- brecha do pedido #44 (sem pino, bairro que não casou, taxa zero).
    select round(min((f->>'taxa')::numeric), 2)
      into v_taxa
      from jsonb_array_elements(v_emp.taxas_entrega_km) f;
    return v_taxa;
  end if;

  -- 3) Loja de taxa fixa.
  return round(coalesce(v_emp.taxa_entrega, 0), 2);
end;
$$;

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
    NEW.empresa_id, NEW.endereco_bairro, NEW.endereco_lat, NEW.endereco_lng);

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

drop trigger if exists trg_validar_taxa_entrega on public.pedidos_delivery;
create trigger trg_validar_taxa_entrega
  before insert on public.pedidos_delivery
  for each row execute function public.validar_taxa_entrega_pedido();

-- O create-pix-payment consulta a taxa esperada ANTES de mandar gerar o QR no
-- Mercado Pago: sem isso a cobrança nasceria e só depois o insert seria
-- recusado, deixando cobrança órfã na conta da loja.
grant execute on function public.taxa_entrega_esperada(uuid, text, double precision, double precision) to anon, authenticated, service_role;
grant execute on function public.norm_bairro(text) to anon, authenticated, service_role;
