-- Indicação — Fase 2: o crédito nascendo (mig 0174 fez a carteira).
--
-- Um evento só paga os dois lados: a PRIMEIRA compra de quem chegou pelo link
-- de alguém. Quem indicou ganha `pct_indicacao`, o indicado ganha
-- `pct_cashback`, e aquele par nunca mais rende nada.
--
-- POR QUE NA COMPRA CONCLUÍDA e não no pedido: senão vira pedido fantasma —
-- faz o pedido, o amigo ganha o crédito, cancela depois. Delivery paga quando
-- vai pra 'entregue'; mesa e balcão pagam quando a venda é gerada, que só
-- acontece com a conta fechada.
--
-- Vale nos dois canais porque o indicado pode aparecer no salão em vez de
-- pedir pelo app — foi decisão do lojista.

-- ── 1) Registrar o vínculo ───────────────────────────────────────────────────
-- Chamada quando alguém se cadastra tendo chegado por um link `?ind=<token>`.
--
-- Aqui moram as travas de fraude. Sem elas o golpe é barato e óbvio: cadastro
-- novo com outro telefone, se auto-indica, leva os dois percentuais de uma vez.
-- Devolve texto em vez de estourar: indicação inválida não pode derrubar o
-- cadastro do cliente, que é o que realmente importa naquele momento.
CREATE OR REPLACE FUNCTION public.indicacao_registrar(p_token_indicador text, p_cliente_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ind  clientes%ROWTYPE;   -- quem indicou
  v_novo clientes%ROWTYPE;   -- o indicado
  v_cfg  fidelidade_config%ROWTYPE;
  v_fone_ind  text;
  v_fone_novo text;
BEGIN
  IF p_token_indicador IS NULL OR p_cliente_id IS NULL THEN RETURN 'sem_dados'; END IF;

  SELECT * INTO v_novo FROM clientes WHERE id = p_cliente_id;
  IF v_novo.id IS NULL THEN RETURN 'indicado_inexistente'; END IF;

  SELECT * INTO v_ind FROM clientes WHERE token = p_token_indicador;
  IF v_ind.id IS NULL THEN RETURN 'indicador_inexistente'; END IF;

  -- O crédito é da loja: indicador e indicado têm que ser da MESMA.
  IF v_ind.empresa_id <> v_novo.empresa_id THEN RETURN 'outra_loja'; END IF;

  SELECT * INTO v_cfg FROM fidelidade_config WHERE empresa_id = v_novo.empresa_id;
  IF v_cfg.empresa_id IS NULL OR NOT v_cfg.ativo THEN RETURN 'programa_desligado'; END IF;

  IF v_ind.id = v_novo.id THEN RETURN 'auto_indicacao'; END IF;

  -- Mesmo telefone = mesma pessoa com dois cadastros. É o golpe mais provável.
  v_fone_ind  := regexp_replace(COALESCE(v_ind.telefone, ''),  '\D', '', 'g');
  v_fone_novo := regexp_replace(COALESCE(v_novo.telefone, ''), '\D', '', 'g');
  IF v_fone_ind <> '' AND v_fone_ind = v_fone_novo THEN RETURN 'mesmo_telefone'; END IF;

  -- Indicado tem que ser gente NOVA. Quem já comprou antes não é indicação —
  -- é cliente da casa sendo reciclado pra gerar crédito.
  IF EXISTS (SELECT 1 FROM pedidos_delivery
              WHERE cliente_id = v_novo.id AND status <> 'cancelado')
     OR EXISTS (SELECT 1 FROM vendas
                 WHERE cliente_id = v_novo.id AND status <> 'cancelado') THEN
    RETURN 'ja_era_cliente';
  END IF;

  -- O unique index (mig 0174) é quem garante o "uma vez só" de verdade; este
  -- INSERT só não estoura quando já existe.
  INSERT INTO indicacoes (empresa_id, indicador_id, indicado_id)
  VALUES (v_novo.empresa_id, v_ind.id, v_novo.id)
  ON CONFLICT (empresa_id, indicado_id) DO NOTHING;

  IF NOT FOUND THEN RETURN 'ja_indicado'; END IF;
  RETURN 'ok';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.indicacao_registrar(text, uuid) FROM public;
GRANT  EXECUTE ON FUNCTION public.indicacao_registrar(text, uuid) TO anon, authenticated;

-- ── 2) Quitar a indicação ────────────────────────────────────────────────────
-- Roda quando a primeira compra do indicado conclui. Paga os dois e fecha o
-- vínculo — em qualquer canal.
CREATE OR REPLACE FUNCTION public.indicacao_quitar(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_valor      numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_i    indicacoes%ROWTYPE;
  v_cfg  fidelidade_config%ROWTYPE;
  v_nome text;
  v_ci   numeric;   -- crédito de quem indicou
  v_cc   numeric;   -- cashback do indicado
BEGIN
  IF p_cliente_id IS NULL OR COALESCE(p_valor, 0) <= 0 THEN RETURN; END IF;

  -- Trava a linha: delivery e mesa podem concluir quase juntos, e sem isto os
  -- dois pagariam a mesma indicação.
  SELECT * INTO v_i FROM indicacoes
  WHERE empresa_id = p_empresa_id AND indicado_id = p_cliente_id AND status = 'pendente'
  FOR UPDATE;
  IF v_i.id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_cfg FROM fidelidade_config WHERE empresa_id = p_empresa_id;
  IF v_cfg.empresa_id IS NULL OR NOT v_cfg.ativo THEN RETURN; END IF;

  -- Compra pequena demais não paga, mas também não queima a indicação: fica
  -- pendente pra próxima. Recusar aqui puniria o indicado por ter comprado
  -- pouco na estreia.
  IF COALESCE(v_cfg.compra_minima, 0) > 0 AND p_valor < v_cfg.compra_minima THEN
    RETURN;
  END IF;

  v_ci := ROUND(p_valor * COALESCE(v_cfg.pct_indicacao, 0) / 100.0, 2);
  v_cc := ROUND(p_valor * COALESCE(v_cfg.pct_cashback,  0) / 100.0, 2);

  SELECT nome INTO v_nome FROM clientes WHERE id = p_cliente_id;

  -- O teto e a validade são aplicados dentro do `fidelidade_creditar`.
  PERFORM fidelidade_creditar(p_empresa_id, v_i.indicador_id, v_ci, 'indicacao',
            'Indicação de ' || COALESCE(v_nome, 'um amigo'), v_i.id);
  PERFORM fidelidade_creditar(p_empresa_id, p_cliente_id, v_cc, 'cashback',
            'Cashback da sua primeira compra', v_i.id);

  UPDATE indicacoes
     SET status = 'pago', valor_compra = p_valor,
         credito_indicador = v_ci, credito_indicado = v_cc, pago_em = now()
   WHERE id = v_i.id;
END;
$function$;

-- ── 3) Gatilho do delivery ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_indicacao_pedido_entregue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'entregue' AND COALESCE(OLD.status, '') <> 'entregue' THEN
    PERFORM indicacao_quitar(NEW.empresa_id, NEW.cliente_id, NEW.total);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_indicacao_pedido_entregue ON public.pedidos_delivery;
CREATE TRIGGER trg_indicacao_pedido_entregue
  AFTER UPDATE ON public.pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION public.fn_indicacao_pedido_entregue();

-- ── 4) Gatilho da mesa e do balcão ───────────────────────────────────────────
-- A venda só nasce com a conta fechada, então aqui não precisa esperar status.
CREATE OR REPLACE FUNCTION public.fn_indicacao_venda()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.status, '') <> 'cancelado' AND NEW.cliente_id IS NOT NULL THEN
    PERFORM indicacao_quitar(NEW.empresa_id, NEW.cliente_id, NEW.total);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_indicacao_venda ON public.vendas;
CREATE TRIGGER trg_indicacao_venda
  AFTER INSERT ON public.vendas
  FOR EACH ROW EXECUTE FUNCTION public.fn_indicacao_venda();

-- ── 5) O painel do cliente ───────────────────────────────────────────────────
-- Tudo que a aba "Indicar" mostra, numa chamada só: o link, o saldo, quem ele
-- já trouxe e o extrato. Sem login — quem identifica é o token.
CREATE OR REPLACE FUNCTION public.cliente_indicacao(p_token text)
RETURNS json
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cli clientes%ROWTYPE;
  v_cfg fidelidade_config%ROWTYPE;
  v_emp empresas%ROWTYPE;
BEGIN
  SELECT * INTO v_cli FROM clientes WHERE token = p_token;
  IF v_cli.id IS NULL THEN RETURN json_build_object('ativo', false); END IF;

  SELECT * INTO v_cfg FROM fidelidade_config WHERE empresa_id = v_cli.empresa_id;
  IF v_cfg.empresa_id IS NULL OR NOT v_cfg.ativo THEN
    RETURN json_build_object('ativo', false);
  END IF;

  SELECT * INTO v_emp FROM empresas WHERE id = v_cli.empresa_id;

  RETURN json_build_object(
    'ativo',         true,
    'slug',          v_emp.slug,
    'token',         v_cli.token,
    'pct_indicacao', v_cfg.pct_indicacao,
    'pct_cashback',  v_cfg.pct_cashback,
    'saldo',         COALESCE((SELECT saldo FROM creditos_cliente
                                WHERE empresa_id = v_cli.empresa_id AND cliente_id = v_cli.id), 0),
    'total_ganho',   COALESCE((SELECT total_ganho FROM creditos_cliente
                                WHERE empresa_id = v_cli.empresa_id AND cliente_id = v_cli.id), 0),
    'indicados', COALESCE((
      SELECT json_agg(json_build_object(
               'nome',    split_part(COALESCE(c.nome, 'Amigo'), ' ', 1),
               'status',  i.status,
               'credito', i.credito_indicador,
               'quando',  i.created_at
             ) ORDER BY i.created_at DESC)
      FROM indicacoes i JOIN clientes c ON c.id = i.indicado_id
      WHERE i.empresa_id = v_cli.empresa_id AND i.indicador_id = v_cli.id
    ), '[]'::json),
    'extrato', COALESCE((
      SELECT json_agg(json_build_object(
               'tipo',      m.tipo,
               'valor',     m.valor,
               'descricao', m.descricao,
               'quando',    m.created_at,
               'expira_em', m.expira_em
             ) ORDER BY m.created_at DESC)
      FROM (SELECT * FROM creditos_movimentos
             WHERE empresa_id = v_cli.empresa_id AND cliente_id = v_cli.id
             ORDER BY created_at DESC LIMIT 30) m
    ), '[]'::json)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_indicacao(text) FROM public;
GRANT  EXECUTE ON FUNCTION public.cliente_indicacao(text) TO anon, authenticated;
