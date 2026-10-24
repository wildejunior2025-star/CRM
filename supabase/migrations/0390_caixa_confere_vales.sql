-- 0390 — Fechar o caixa conferindo cada vale (Pluxee, Alelo, VR, Ticket)
--
-- O fechamento do caixa pede o que foi CONTADO em dinheiro, PIX e na maquineta
-- do cartão pra bater com o esperado. Os vales entraram como forma de pagamento
-- (0388) mas não tinham onde ser conferidos: cada bandeira tem a própria
-- maquineta, e é o fechamento DELA que o lojista compara com o sistema.
--
-- Guarda por bandeira, em JSON:  { "pluxee": { "contado": 120.5, "esperado": 120.5 }, ... }
-- O esperado fica congelado junto, igual aos outros: pedido cancelado depois não
-- muda a diferença de um caixa que já foi conferido.

ALTER TABLE caixas    ADD COLUMN IF NOT EXISTS conferido_vales jsonb;
ALTER TABLE caixa_dia ADD COLUMN IF NOT EXISTS conferido_vales jsonb;

-- A view do delivery guardava só o balde ("vale") — pra conferir bandeira por
-- bandeira precisa saber de QUAL foi cada parte (num pagamento dividido, a forma
-- está dentro da parte, não no pedido). Coluna nova no FIM: não quebra ninguém.
CREATE OR REPLACE VIEW caixa_delivery_partes AS
 SELECT d.caixa_id,
    d.id AS pedido_id,
    x.bucket,
    x.valor,
    d.numero_pedido,
    d.origem,
    d.cliente_nome,
    d.created_at,
    d.forma_pagamento,
    d.empresa_id,
    (d.created_at AT TIME ZONE 'America/Fortaleza'::text)::date AS dia,
    x.forma
   FROM pedidos_delivery d
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN d.origem = 'ifood'::text AND (COALESCE(d.ifood_valores ->> 'pago_online'::text, ''::text) = 'true'::text OR f.forma = 'online'::text) THEN 'ifood'::text
                    WHEN f.forma = 'online'::text THEN 'online'::text
                    WHEN f.forma = 'pix'::text AND d.mp_payment_status = 'approved'::text THEN 'online'::text
                    WHEN f.forma = 'dinheiro'::text THEN 'dinheiro'::text
                    WHEN f.forma = ANY (ARRAY['pix'::text, 'pix_entrega'::text]) THEN 'pix'::text
                    WHEN f.forma = 'credito'::text THEN 'credito'::text
                    WHEN f.forma = 'debito'::text THEN 'debito'::text
                    WHEN f.forma = 'cartao'::text THEN 'cartao'::text
                    WHEN f.forma = ANY (ARRAY['pluxee'::text, 'alelo'::text, 'vr'::text, 'ticket'::text]) THEN 'vale'::text
                    ELSE 'outros'::text
                END AS bucket,
            f.valor,
            f.forma
           FROM ( SELECT p.value ->> 'forma'::text AS forma,
                    (p.value ->> 'valor'::text)::numeric AS valor
                   FROM jsonb_array_elements(d.pagamentos) p(value)
                  WHERE d.forma_pagamento = 'dividido'::text AND jsonb_typeof(d.pagamentos) = 'array'::text
                UNION ALL
                 SELECT d.forma_pagamento,
                    d.total
                  WHERE d.forma_pagamento IS DISTINCT FROM 'dividido'::text OR jsonb_typeof(d.pagamentos) IS DISTINCT FROM 'array'::text) f) x
  WHERE d.empresa_id = current_empresa_id() AND (d.status <> ALL (ARRAY['cancelado'::text, 'aguardando'::text, 'aguardando_pagamento'::text])) AND COALESCE(d.forma_pagamento, ''::text) <> 'fiado'::text;

-- fechar_caixa ganha o 6º parâmetro. A assinatura antiga SAI: deixar as duas daria
-- "função não é única" pra quem chama com os 5 nomes de sempre.
DROP FUNCTION IF EXISTS fechar_caixa(uuid, numeric, text, numeric, numeric);
CREATE FUNCTION fechar_caixa(
  p_caixa_id uuid,
  p_valor_fechamento numeric,
  p_observacoes text DEFAULT NULL::text,
  p_valor_fechamento_pix numeric DEFAULT NULL::numeric,
  p_valor_fechamento_cartao numeric DEFAULT NULL::numeric,
  p_conferido_vales jsonb DEFAULT NULL::jsonb
) RETURNS void
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

  if p_valor_fechamento_cartao is not null and p_valor_fechamento_cartao < 0 then
    raise exception 'Valor de cartão inválido';
  end if;

  if p_conferido_vales is not null and jsonb_typeof(p_conferido_vales) <> 'object' then
    raise exception 'Conferência dos vales em formato inválido';
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
      conferido_vales = p_conferido_vales,
      observacoes_fechamento = p_observacoes
  where id = p_caixa_id;
end;
$function$;

REVOKE ALL ON FUNCTION fechar_caixa(uuid, numeric, text, numeric, numeric, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fechar_caixa(uuid, numeric, text, numeric, numeric, jsonb) TO authenticated, service_role;
