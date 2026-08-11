-- 0156_caixa_pix_inicial.sql
-- Abertura de caixa agora tem DOIS saldos iniciais: dinheiro e PIX.
--
-- Por quê: o "esperado em PIX" já existia (recebido por PIX + suprimentos − sangrias
-- por PIX), mas começava sempre do zero. Se a loja vira o dia com saldo na conta do
-- PIX — ou se sobrou PIX do caixa anterior — o conferido no fechamento aparecia
-- "sobrando" todo dia, exatamente como aconteceria com o dinheiro da gaveta se não
-- existisse valor de abertura.
--
-- Agora o PIX funciona igualzinho ao dinheiro: saldo inicial na abertura, sangria e
-- suprimento por PIX (já existiam, migration 0134) e conferência no fechamento.

-- 1) Coluna (caixas antigos ficam com 0, que é o comportamento de hoje)
ALTER TABLE public.caixas
  ADD COLUMN IF NOT EXISTS valor_abertura_pix numeric NOT NULL DEFAULT 0;

-- 2) RPC ganha o valor de PIX. A assinatura antiga precisa sair: com as duas no ar,
--    a chamada de 2 argumentos ficaria ambígua ("function is not unique").
DROP FUNCTION IF EXISTS public.abrir_caixa(numeric, text);

CREATE OR REPLACE FUNCTION public.abrir_caixa(
  p_valor_abertura numeric,
  p_observacoes text DEFAULT NULL::text,
  p_valor_abertura_pix numeric DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_pix numeric := coalesce(p_valor_abertura_pix, 0);
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para abrir caixa';
  end if;

  if exists (select 1 from caixas where aberto_por = auth.uid() and status = 'aberto') then
    raise exception 'Você já tem um caixa aberto';
  end if;

  if p_valor_abertura < 0 then
    raise exception 'Valor de abertura inválido';
  end if;

  if v_pix < 0 then
    raise exception 'Valor de abertura em PIX inválido';
  end if;

  insert into caixas (aberto_por, valor_abertura, valor_abertura_pix, observacoes_abertura)
  values (auth.uid(), p_valor_abertura, v_pix, p_observacoes)
  returning id into v_id;

  return v_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.abrir_caixa(numeric, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.abrir_caixa(numeric, text, numeric) TO authenticated;

NOTIFY pgrst, 'reload schema';
