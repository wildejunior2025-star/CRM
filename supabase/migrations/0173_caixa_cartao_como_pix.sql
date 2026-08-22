-- Cartão no caixa passa a funcionar igual ao PIX: tem saldo de abertura,
-- aceita sangria e tem valor esperado no fechamento.
--
-- Até aqui o cartão era só conferência: comparava o total da maquineta com o
-- que o sistema lançou no dia. Só que o dinheiro do cartão cai na hora (igual
-- PIX) e a loja também tira dali pra pagar compra — então o saldo anda de um
-- dia pro outro e precisa fechar em corrente, como o PIX já faz.
--
-- Quatro peças: coluna de abertura, a forma 'cartao' na sangria, os totais na
-- view do resumo e o cartão entrando na regra "abre com o fechamento anterior".

-- 1) Saldo de cartão na abertura
ALTER TABLE public.caixas ADD COLUMN IF NOT EXISTS valor_abertura_cartao numeric NOT NULL DEFAULT 0;

-- 2) Sangria/suprimento em cartão
CREATE OR REPLACE FUNCTION public.registrar_movimento_caixa(p_caixa_id uuid, p_tipo text, p_valor numeric, p_observacao text DEFAULT NULL::text, p_forma text DEFAULT 'dinheiro'::text)
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

  if v_forma not in ('dinheiro', 'pix', 'cartao') then
    raise exception 'Forma inválida (use dinheiro, pix ou cartao)';
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

-- 3) Totais de cartão no resumo (a view é recriada inteira porque só dá pra
--    acrescentar coluna no fim; o resto está igual)
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
    COALESCE(mv.total_suprimentos_pix, 0::numeric) AS total_suprimentos_pix,
    COALESCE(pg.recebimentos_fiado, 0::numeric) AS recebimentos_fiado,
    COALESCE(pg.recebimentos_fiado_dinheiro, 0::numeric) AS recebimentos_fiado_dinheiro,
    COALESCE(pg.recebimentos_fiado_pix, 0::numeric) AS recebimentos_fiado_pix,
    COALESCE(pg.recebimentos_fiado_cartao, 0::numeric) AS recebimentos_fiado_cartao,
    COALESCE(pg.recebimentos_fiado_transferencia, 0::numeric) AS recebimentos_fiado_transferencia,
    COALESCE(pg.recebimentos_credito, 0::numeric) AS recebimentos_credito,
    COALESCE(pg.recebimentos_debito, 0::numeric) AS recebimentos_debito,
    COALESCE(pg.recebimentos_cartao_generico, 0::numeric) AS recebimentos_cartao_generico,
    COALESCE(pg.recebimentos_fiado_credito, 0::numeric) AS recebimentos_fiado_credito,
    COALESCE(pg.recebimentos_fiado_debito, 0::numeric) AS recebimentos_fiado_debito,
    COALESCE(mv.total_sangrias_cartao, 0::numeric) AS total_sangrias_cartao,
    COALESCE(mv.total_suprimentos_cartao, 0::numeric) AS total_suprimentos_cartao
   FROM caixas c
     LEFT JOIN LATERAL ( SELECT sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'a_vista'::text AND vendas.status <> 'cancelado'::text) AS vendas_a_vista,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento = 'fiado'::text AND vendas.status <> 'cancelado'::text) AS vendas_fiado,
            sum(vendas.total) FILTER (WHERE vendas.forma_pagamento ~~ 'boleto%'::text AND vendas.status <> 'cancelado'::text) AS vendas_boleto
           FROM vendas
          WHERE vendas.caixa_id = c.id) ve ON true
     LEFT JOIN LATERAL ( SELECT sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_pix,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_transferencia,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = ANY (ARRAY['cartao'::text, 'credito'::text, 'debito'::text])) AS recebimentos_cartao,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'credito'::text) AS recebimentos_credito,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'debito'::text) AS recebimentos_debito,
            sum(pagamentos.valor) FILTER (WHERE pagamentos.forma_pagamento = 'cartao'::text) AS recebimentos_cartao_generico,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text) AS recebimentos_fiado,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'dinheiro'::text) AS recebimentos_fiado_dinheiro,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'pix'::text) AS recebimentos_fiado_pix,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND (pagamentos.forma_pagamento = ANY (ARRAY['cartao'::text, 'credito'::text, 'debito'::text]))) AS recebimentos_fiado_cartao,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'credito'::text) AS recebimentos_fiado_credito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'debito'::text) AS recebimentos_fiado_debito,
            sum(pagamentos.valor) FILTER (WHERE COALESCE(pagamentos.observacao, ''::text) = 'Recebimento de fiado'::text AND pagamentos.forma_pagamento = 'transferencia'::text) AS recebimentos_fiado_transferencia
           FROM pagamentos
          WHERE pagamentos.caixa_id = c.id) pg ON true
     LEFT JOIN LATERAL ( SELECT sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text) AS total_sangrias,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text) AS total_suprimentos,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_sangrias_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'pix'::text) AS total_sangrias_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'sangria'::text AND caixa_movimentos.forma = 'cartao'::text) AS total_sangrias_cartao,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND COALESCE(caixa_movimentos.forma, 'dinheiro'::text) = 'dinheiro'::text) AS total_suprimentos_dinheiro,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'pix'::text) AS total_suprimentos_pix,
            sum(caixa_movimentos.valor) FILTER (WHERE caixa_movimentos.tipo = 'suprimento'::text AND caixa_movimentos.forma = 'cartao'::text) AS total_suprimentos_cartao
           FROM caixa_movimentos
          WHERE caixa_movimentos.caixa_id = c.id) mv ON true
  WHERE c.empresa_id = current_empresa_id();

-- 4) O fechamento anterior passa a devolver o cartão também...
CREATE OR REPLACE FUNCTION public.ultimo_fechamento_caixa()
 RETURNS TABLE(fechado_em timestamp with time zone, valor_dinheiro numeric, valor_pix numeric, valor_cartao numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.fechado_em,
         coalesce(c.valor_fechamento_informado, 0),
         coalesce(c.valor_fechamento_pix, 0),
         coalesce(c.valor_fechamento_cartao, 0)
  from caixas c
  where c.empresa_id = current_empresa_id()
    and c.status = 'fechado'
    and c.fechado_em is not null
  order by c.fechado_em desc
  limit 1
$function$;

-- ...e a abertura herda o saldo de cartão quando a loja usa "abre com o fechamento".
CREATE OR REPLACE FUNCTION public.abrir_caixa(p_valor_abertura numeric, p_observacoes text DEFAULT NULL::text, p_valor_abertura_pix numeric DEFAULT 0, p_valor_abertura_cartao numeric DEFAULT 0)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_valor numeric := p_valor_abertura;
  v_pix numeric := coalesce(p_valor_abertura_pix, 0);
  v_cartao numeric := coalesce(p_valor_abertura_cartao, 0);
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
      v_valor  := v_ant.valor_dinheiro;
      v_pix    := v_ant.valor_pix;
      v_cartao := v_ant.valor_cartao;
    end if;
  end if;

  if v_valor < 0 then
    raise exception 'Valor de abertura inválido';
  end if;

  if v_pix < 0 then
    raise exception 'Valor de abertura em PIX inválido';
  end if;

  if v_cartao < 0 then
    raise exception 'Valor de abertura em cartão inválido';
  end if;

  insert into caixas (aberto_por, valor_abertura, valor_abertura_pix, valor_abertura_cartao, observacoes_abertura)
  values (auth.uid(), v_valor, v_pix, v_cartao, p_observacoes)
  returning id into v_id;

  return v_id;
end;
$function$;
