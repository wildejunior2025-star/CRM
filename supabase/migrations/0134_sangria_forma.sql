-- 0134_sangria_forma.sql
-- Sangria/suprimento agora tem FORMA (dinheiro ou pix). Motivo: tirar dinheiro por
-- PIX não mexe no caixa físico — só a sangria EM DINHEIRO abate do "esperado em
-- dinheiro". Sem isso, uma sangria via PIX fazia o dinheiro contado parecer faltando.

-- 1) Coluna forma (rows antigas viram 'dinheiro' automaticamente)
ALTER TABLE public.caixa_movimentos
  ADD COLUMN IF NOT EXISTS forma text NOT NULL DEFAULT 'dinheiro';

-- 2) RPC passa a receber a forma. Recria a assinatura (agora com p_forma).
DROP FUNCTION IF EXISTS public.registrar_movimento_caixa(uuid, text, numeric, text);
CREATE OR REPLACE FUNCTION public.registrar_movimento_caixa(
  p_caixa_id uuid, p_tipo text, p_valor numeric,
  p_observacao text DEFAULT NULL::text, p_forma text DEFAULT 'dinheiro'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caixa caixas%rowtype;
  v_forma text := lower(btrim(coalesce(p_forma, 'dinheiro')));
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para movimentar caixa';
  end if;

  if p_tipo not in ('sangria', 'suprimento') then
    raise exception 'Tipo de movimento inválido';
  end if;

  if v_forma not in ('dinheiro', 'pix') then
    raise exception 'Forma inválida (use dinheiro ou pix)';
  end if;

  if p_valor <= 0 then
    raise exception 'Valor inválido';
  end if;

  select * into v_caixa from caixas where id = p_caixa_id;

  if v_caixa is null or v_caixa.status <> 'aberto' then
    raise exception 'Caixa não está aberto';
  end if;

  if v_caixa.aberto_por <> auth.uid() and current_perfil() <> 'admin' then
    raise exception 'Sem permissão para movimentar este caixa';
  end if;

  insert into caixa_movimentos (caixa_id, tipo, valor, observacao, forma, created_by)
  values (p_caixa_id, p_tipo, p_valor, p_observacao, v_forma, auth.uid());
end;
$function$;

GRANT EXECUTE ON FUNCTION public.registrar_movimento_caixa(uuid, text, numeric, text, text) TO authenticated;

-- 3) View: mantém os totais gerais e acrescenta o recorte por forma.
CREATE OR REPLACE VIEW public.caixa_resumo AS
 SELECT c.id AS caixa_id,
    COALESCE(ve.vendas_a_vista, 0::numeric) AS vendas_a_vista,
    COALESCE(ve.vendas_fiado, 0::numeric) AS vendas_fiado,
    COALESCE(ve.vendas_boleto, 0::numeric) AS vendas_boleto,
    COALESCE(pg.recebimentos_dinheiro, 0::numeric) AS recebimentos_dinheiro,
    COALESCE(pg.recebimentos_pix, 0::numeric) AS recebimentos_pix,
    COALESCE(pg.recebimentos_transferencia, 0::numeric) AS recebimentos_transferencia,
    COALESCE(pg.recebimentos_cartao, 0::numeric) AS recebimentos_cartao,
    COALESCE(mv.total_sangrias, 0::numeric) AS total_sangrias,
    COALESCE(mv.total_suprimentos, 0::numeric) AS total_suprimentos,
    COALESCE(mv.total_sangrias_dinheiro, 0::numeric) AS total_sangrias_dinheiro,
    COALESCE(mv.total_sangrias_pix, 0::numeric) AS total_sangrias_pix,
    COALESCE(mv.total_suprimentos_dinheiro, 0::numeric) AS total_suprimentos_dinheiro,
    COALESCE(mv.total_suprimentos_pix, 0::numeric) AS total_suprimentos_pix
   FROM caixas c
     LEFT JOIN LATERAL ( SELECT sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'a_vista'::text AND vendas.status <> 'cancelado'::text) AS vendas_a_vista,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'fiado'::text AND vendas.status <> 'cancelado'::text) AS vendas_fiado,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento ~~ 'boleto%'::text AND vendas.status <> 'cancelado'::text) AS vendas_boleto
           FROM vendas
          WHERE vendas.caixa_id = c.id) ve ON true
     LEFT JOIN LATERAL ( SELECT sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_pix,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_transferencia,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'cartao'::text) AS recebimentos_cartao
           FROM pagamentos
          WHERE pagamentos.caixa_id = c.id) pg ON true
     LEFT JOIN LATERAL ( SELECT sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text) AS total_sangrias,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text) AS total_suprimentos,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro') = 'dinheiro') AS total_sangrias_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'pix') AS total_sangrias_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro') = 'dinheiro') AS total_suprimentos_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'pix') AS total_suprimentos_pix
           FROM caixa_movimentos
          WHERE caixa_movimentos.caixa_id = c.id) mv ON true
  WHERE c.empresa_id = current_empresa_id();
