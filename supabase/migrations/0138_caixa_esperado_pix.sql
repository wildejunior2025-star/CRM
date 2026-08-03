-- 0138_caixa_esperado_pix.sql
-- PIX hoje é igual dinheiro: além do "esperado em dinheiro", o caixa passa a ter
-- "esperado em PIX" e permite conferir o valor de PIX no fechamento.

ALTER TABLE public.caixas ADD COLUMN IF NOT EXISTS valor_fechamento_pix numeric;

DROP FUNCTION IF EXISTS public.fechar_caixa(uuid, numeric, text);
CREATE OR REPLACE FUNCTION public.fechar_caixa(
  p_caixa_id uuid,
  p_valor_fechamento numeric,
  p_observacoes text DEFAULT NULL::text,
  p_valor_fechamento_pix numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caixa caixas%rowtype;
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

  update caixas
  set status = 'fechado',
      fechado_em = now(),
      valor_fechamento_informado = p_valor_fechamento,
      valor_fechamento_pix = p_valor_fechamento_pix,
      observacoes_fechamento = p_observacoes
  where id = p_caixa_id;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.fechar_caixa(uuid, numeric, text, numeric) TO authenticated;
