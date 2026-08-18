-- 0169_caixa_confere_cartao.sql
-- Conferência do CARTÃO no fechamento do caixa.
--
-- A maquineta da Estação liquida na hora e imprime o total do dia, então o
-- cartão é conferível igual ao PIX: dá pra bater o papel da maquineta com o
-- que foi lançado. Hoje faltaram R$ 3,50 — venda que passou na maquineta e
-- ninguém lançou. Sem essa conferência, isso só aparece no fim do mês, quando
-- ninguém mais lembra de qual venda foi.
--
-- Atenção: isto NÃO entra no "esperado em dinheiro". Cartão não fica na gaveta.
-- É comparação pura: maquineta × sistema.

alter table public.caixas
  add column if not exists valor_fechamento_cartao numeric;

comment on column public.caixas.valor_fechamento_cartao is
  'Total de cartão que a maquineta fechou no dia, digitado no fechamento. Null = não conferiu.';

-- A assinatura de 4 argumentos precisa sair: com as duas no ar a chamada fica
-- ambígua ("function is not unique").
drop function if exists public.fechar_caixa(uuid, numeric, text, numeric);

create or replace function public.fechar_caixa(
  p_caixa_id uuid,
  p_valor_fechamento numeric,
  p_observacoes text default null::text,
  p_valor_fechamento_pix numeric default null::numeric,
  p_valor_fechamento_cartao numeric default null::numeric)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_caixa caixas%rowtype;
  v_vazio boolean;
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

  -- Caixa fantasma: abriu zerado, fechou zerado e não teve NENHUM movimento
  -- (venda, pagamento, sangria ou suprimento). Não vale guardar no histórico —
  -- é só alguém que abriu sem querer. Apaga em vez de fechar.
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

  update caixas
  set status = 'fechado',
      fechado_em = now(),
      valor_fechamento_informado = p_valor_fechamento,
      valor_fechamento_pix = p_valor_fechamento_pix,
      valor_fechamento_cartao = p_valor_fechamento_cartao,
      observacoes_fechamento = p_observacoes
  where id = p_caixa_id;
end;
$function$;

revoke all on function public.fechar_caixa(uuid, numeric, text, numeric, numeric) from public, anon;
grant execute on function public.fechar_caixa(uuid, numeric, text, numeric, numeric) to authenticated;

notify pgrst, 'reload schema';
