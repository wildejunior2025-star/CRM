CREATE OR REPLACE FUNCTION public.fechar_caixa(p_caixa_id uuid, p_valor_fechamento numeric, p_observacoes text DEFAULT NULL::text, p_valor_fechamento_pix numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Caixa fantasma: abriu zerado, fechou zerado e não teve NENHUM movimento
  -- (venda, pagamento, sangria ou suprimento). Não vale guardar no histórico —
  -- é só alguém que abriu sem querer. Apaga em vez de fechar.
  v_vazio :=
        coalesce(v_caixa.valor_abertura, 0) = 0
    and coalesce(v_caixa.valor_abertura_pix, 0) = 0
    and coalesce(p_valor_fechamento, 0) = 0
    and coalesce(p_valor_fechamento_pix, 0) = 0
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
      observacoes_fechamento = p_observacoes
  where id = p_caixa_id;
end;
$function$;
