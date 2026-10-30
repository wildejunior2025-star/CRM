-- CAIXA "CEGO" PARA O VENDEDOR (30/10/2026)
--
-- Pedido do dono: o vendedor abre o caixa e lança os valores, mas NÃO vê quanto
-- tem no caixa (nem faturamento, nem esperado, nem diferença). No fechamento ele
-- digita o que contou; se não bater com o que o sistema espera, o caixa NÃO fecha
-- sozinho: o vendedor precisa anotar o que faltou (venda, sangria, suprimento) ou
-- pedir a liberação ao dono. O admin segue vendo e fechando tudo como sempre.
--
-- É OPCIONAL, POR LOJA, e nasce DESLIGADO: loja que não ligar não muda em nada.
-- A conferência mora no banco (fechar_caixa) e não só na tela, porque tela se
-- burla — o vendedor só enxerga "bateu / não bateu", nunca o valor esperado.

-- ── 1. A chave, por loja ────────────────────────────────────────────────────
alter table public.empresas
  add column if not exists caixa_cego boolean not null default false;

comment on column public.empresas.caixa_cego is
  'Vendedor não vê o valor do caixa e só fecha se o contado bater com o esperado; senão o dono precisa liberar. Admin não é afetado.';

-- ── 2. O que fica registrado em cada caixa ──────────────────────────────────
alter table public.caixas
  add column if not exists liberacao_pedida_em  timestamptz,
  add column if not exists liberacao_pedida_por uuid,
  add column if not exists liberado_em          timestamptz,
  add column if not exists liberado_por         uuid,
  add column if not exists fechamento_esperado  jsonb;

comment on column public.caixas.fechamento_esperado is
  'Foto do que o sistema esperava no fechamento feito por vendedor em loja com caixa cego: {dinheiro, pix, cartao, liberado}. Serve pro dono ver a diferença depois.';

-- ── 3. Quanto o sistema espera em cada forma ────────────────────────────────
-- A MESMA conta do Caixa.jsx (valorEsperadoDinheiro/Pix/Cartao): abertura +
-- recebido + suprimentos − sangrias; o cartão entra LÍQUIDO da taxa da maquineta.
create or replace function public.caixa_esperado(p_caixa_id uuid)
returns table (dinheiro numeric, pix numeric, cartao numeric)
language sql
stable
security definer
set search_path to 'public'
as $$
  select
    round(coalesce(c.valor_abertura, 0)
      + r.recebimentos_dinheiro + r.delivery_dinheiro
      + r.total_suprimentos_dinheiro - r.total_sangrias_dinheiro, 2),
    round(coalesce(c.valor_abertura_pix, 0)
      + r.recebimentos_pix + r.delivery_pix
      + r.total_suprimentos_pix - r.total_sangrias_pix, 2),
    round(coalesce(c.valor_abertura_cartao, 0)
      + (r.recebimentos_credito + r.delivery_credito) * (1 - coalesce(e.taxa_credito_pct, 0) / 100)
      + (r.recebimentos_debito  + r.delivery_debito)  * (1 - coalesce(e.taxa_debito_pct, 0) / 100)
      + (r.recebimentos_cartao_generico + r.delivery_cartao_generico) * (1 - coalesce(e.taxa_cartao_pct, 0) / 100)
      + r.total_suprimentos_cartao - r.total_sangrias_cartao, 2)
  from caixas c
  join empresas e on e.id = c.empresa_id
  join caixa_resumo r on r.caixa_id = c.id
  where c.id = p_caixa_id
    and c.empresa_id = current_empresa_id();
$$;

revoke all on function public.caixa_esperado(uuid) from public, anon;
grant execute on function public.caixa_esperado(uuid) to authenticated;

-- ── 4. Fechar caixa: vendedor em loja de caixa cego só fecha se bater ───────
-- (CREATE OR REPLACE apaga SECURITY DEFINER se esquecer — por isso vai explícito.)
create or replace function public.fechar_caixa(
  p_caixa_id uuid,
  p_valor_fechamento numeric,
  p_observacoes text default null,
  p_valor_fechamento_pix numeric default null,
  p_valor_fechamento_cartao numeric default null,
  p_conferido_vales jsonb default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_caixa caixas%rowtype;
  v_vazio boolean;
  v_cego boolean;
  v_esp record;
  v_foto jsonb;
  v_erra text[] := '{}';
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para fechar caixa';
  end if;

  select * into v_caixa from caixas where id = p_caixa_id;

  if v_caixa is null then
    raise exception 'Caixa não encontrado';
  end if;

  if v_caixa.status <> 'aberto' then
    raise exception 'Caixa já está fechado';
  end if;

  if v_caixa.aberto_por <> auth.uid() and current_perfil() <> 'admin' then
    raise exception 'Sem permissão para fechar este caixa';
  end if;

  if p_valor_fechamento < 0 then
    raise exception 'Valor de fechamento inválido';
  end if;

  if p_valor_fechamento_pix is not null and p_valor_fechamento_pix < 0 then
    raise exception 'Valor de PIX inválido';
  end if;

  if p_valor_fechamento_cartao is not null and p_valor_fechamento_cartao < 0 then
    raise exception 'Valor de cartão inválido';
  end if;

  if p_conferido_vales is not null and jsonb_typeof(p_conferido_vales) <> 'object' then
    raise exception 'Conferência dos vales em formato inválido';
  end if;

  v_vazio :=
        coalesce(v_caixa.valor_abertura, 0) = 0
    and coalesce(v_caixa.valor_abertura_pix, 0) = 0
    and coalesce(p_valor_fechamento, 0) = 0
    and coalesce(p_valor_fechamento_pix, 0) = 0
    and coalesce(p_valor_fechamento_cartao, 0) = 0
    and not exists (select 1 from vendas where caixa_id = p_caixa_id)
    and not exists (select 1 from pagamentos where caixa_id = p_caixa_id)
    and not exists (select 1 from caixa_movimentos where caixa_id = p_caixa_id);

  if v_vazio then
    delete from caixas where id = p_caixa_id;
    return;
  end if;

  -- ── CAIXA CEGO ──
  -- Só vale pra vendedor numa loja com a chave ligada. Dinheiro e PIX: 1 centavo
  -- de folga (arredondamento). Cartão: 10 centavos, porque a maquineta arredonda a
  -- taxa venda a venda e o saldo dela raramente bate no centavo com a nossa conta.
  select coalesce(e.caixa_cego, false) into v_cego
  from empresas e where e.id = v_caixa.empresa_id;

  if coalesce(v_cego, false) and current_perfil() <> 'admin' then
    select * into v_esp from caixa_esperado(p_caixa_id);

    if abs(coalesce(p_valor_fechamento, 0) - coalesce(v_esp.dinheiro, 0)) > 0.011 then
      v_erra := array_append(v_erra, 'dinheiro');
    end if;
    if abs(coalesce(p_valor_fechamento_pix, 0) - coalesce(v_esp.pix, 0)) > 0.011 then
      v_erra := array_append(v_erra, 'pix');
    end if;
    if abs(coalesce(p_valor_fechamento_cartao, 0) - coalesce(v_esp.cartao, 0)) > 0.101 then
      v_erra := array_append(v_erra, 'cartao');
    end if;

    if array_length(v_erra, 1) > 0 and v_caixa.liberado_em is null then
      -- Só diz QUAL forma não bateu, nunca quanto: o vendedor não pode descobrir
      -- o valor esperado por tentativa.
      raise exception 'CAIXA_NAO_BATEU:%', array_to_string(v_erra, ',');
    end if;

    v_foto := jsonb_build_object(
      'dinheiro', v_esp.dinheiro, 'pix', v_esp.pix, 'cartao', v_esp.cartao,
      'liberado', coalesce(array_length(v_erra, 1), 0) > 0
    );
  end if;

  update caixas
  set status = 'fechado',
      fechado_em = now(),
      valor_fechamento_informado = p_valor_fechamento,
      valor_fechamento_pix = p_valor_fechamento_pix,
      valor_fechamento_cartao = p_valor_fechamento_cartao,
      conferido_vales = p_conferido_vales,
      observacoes_fechamento = p_observacoes,
      fechamento_esperado = coalesce(v_foto, fechamento_esperado)
  where id = p_caixa_id;
end;
$function$;

-- ── 5. Vendedor pede a liberação; o dono libera ─────────────────────────────
create or replace function public.pedir_liberacao_fechamento(p_caixa_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão';
  end if;

  update caixas
  set liberacao_pedida_em = now(), liberacao_pedida_por = auth.uid()
  where id = p_caixa_id
    and empresa_id = current_empresa_id()
    and status = 'aberto'
    and liberado_em is null
    and (aberto_por = auth.uid() or current_perfil() = 'admin');

  if not found then
    raise exception 'Caixa não encontrado, já fechado ou já liberado';
  end if;
end;
$$;

create or replace function public.liberar_fechamento_caixa(p_caixa_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if current_perfil() <> 'admin' then
    raise exception 'Só o dono pode liberar o fechamento';
  end if;

  update caixas
  set liberado_em = now(), liberado_por = auth.uid()
  where id = p_caixa_id
    and empresa_id = current_empresa_id()
    and status = 'aberto';

  if not found then
    raise exception 'Caixa não encontrado ou já fechado';
  end if;
end;
$$;

revoke all on function public.pedir_liberacao_fechamento(uuid) from public, anon;
revoke all on function public.liberar_fechamento_caixa(uuid) from public, anon;
grant execute on function public.pedir_liberacao_fechamento(uuid) to authenticated;
grant execute on function public.liberar_fechamento_caixa(uuid) to authenticated;
