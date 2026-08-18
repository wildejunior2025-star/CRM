-- 0167_caixa_abre_com_fechamento.sql
-- "O caixa tem que abrir com o mesmo valor que fechou ontem."
--
-- A funcionária abriu o caixa com R$ 2,28 no PIX quando o dia anterior tinha
-- fechado com R$ 268,70 — e aí o fechamento acusa uma sobra/falta que não existe.
-- Com a regra ligada, a abertura NÃO é digitada: ela vem do último fechamento.
-- Se o dinheiro de verdade não bate, o certo é registrar sangria/suprimento,
-- não maquiar a abertura.
--
-- É por loja (o Wilde pediu só na Estação do Sabor), e a trava fica no BANCO —
-- se ficasse só na tela, qualquer chamada direta furaria a regra.

alter table public.empresas
  add column if not exists caixa_abre_com_fechamento boolean not null default false;

-- Último fechamento da loja. SECURITY DEFINER porque o vendedor só enxerga os
-- caixas dele pela RLS, mas precisa ver o valor que o caixa anterior fechou.
create or replace function public.ultimo_fechamento_caixa()
returns table (fechado_em timestamptz, valor_dinheiro numeric, valor_pix numeric)
language sql
security definer
stable
set search_path to 'public'
as $$
  select c.fechado_em,
         coalesce(c.valor_fechamento_informado, 0),
         coalesce(c.valor_fechamento_pix, 0)
  from caixas c
  where c.empresa_id = current_empresa_id()
    and c.status = 'fechado'
    and c.fechado_em is not null
  order by c.fechado_em desc
  limit 1
$$;

revoke all on function public.ultimo_fechamento_caixa() from public, anon;
grant execute on function public.ultimo_fechamento_caixa() to authenticated;

create or replace function public.abrir_caixa(
  p_valor_abertura numeric,
  p_observacoes text DEFAULT NULL::text,
  p_valor_abertura_pix numeric DEFAULT 0)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_id uuid;
  v_valor numeric := p_valor_abertura;
  v_pix numeric := coalesce(p_valor_abertura_pix, 0);
  v_regra boolean;
  v_ant record;
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para abrir caixa';
  end if;

  if exists (select 1 from caixas where aberto_por = auth.uid() and status = 'aberto') then
    raise exception 'Você já tem um caixa aberto';
  end if;

  -- Loja com a regra ligada: o que veio da tela é ignorado, vale o fechamento
  -- anterior. Sem caixa anterior (primeira vez), segue o que foi digitado.
  select coalesce(e.caixa_abre_com_fechamento, false) into v_regra
  from empresas e where e.id = current_empresa_id();

  if coalesce(v_regra, false) then
    select * into v_ant from ultimo_fechamento_caixa();
    if v_ant.fechado_em is not null then
      v_valor := v_ant.valor_dinheiro;
      v_pix   := v_ant.valor_pix;
    end if;
  end if;

  if v_valor < 0 then
    raise exception 'Valor de abertura inválido';
  end if;

  if v_pix < 0 then
    raise exception 'Valor de abertura em PIX inválido';
  end if;

  insert into caixas (aberto_por, valor_abertura, valor_abertura_pix, observacoes_abertura)
  values (auth.uid(), v_valor, v_pix, p_observacoes)
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.abrir_caixa(numeric, text, numeric) from public, anon;
grant execute on function public.abrir_caixa(numeric, text, numeric) to authenticated;

-- Liga só na Estação do Sabor, que foi onde o Wilde pediu.
update public.empresas
set caixa_abre_com_fechamento = true
where id = '39c20133-3272-4ee5-add3-7a54895d4f29';

notify pgrst, 'reload schema';
