-- =========================================================
-- Migration 0264 - "Já paguei" libera a loja inteira por 1 hora
-- =========================================================
-- O PIX às vezes demora a cair. Sem isto o dono pagava e continuava travado —
-- e os funcionários, em outros aparelhos, também. A liberação fica no banco
-- (vale pra todo mundo da loja) e só pode ser usada uma vez por dia.
-- =========================================================
ALTER TABLE public.mensalidade_config
  ADD COLUMN IF NOT EXISTS liberado_ate timestamptz;

CREATE OR REPLACE FUNCTION public.mensalidade_ja_paguei()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp  uuid := current_empresa_id();
  v_hoje date := (now() AT TIME ZONE 'America/Fortaleza')::date;
BEGIN
  IF v_emp IS NULL OR current_perfil() <> 'admin' THEN
    RETURN json_build_object('ok', false, 'erro', 'Só o administrador da loja.');
  END IF;
  IF EXISTS (SELECT 1 FROM mensalidade_avisos WHERE empresa_id = v_emp AND tipo = 'ja_paguei' AND dia = v_hoje) THEN
    RETURN json_build_object('ok', false, 'erro', 'A liberação de 1 hora já foi usada hoje. Se já pagou, fale com a FWC pelo WhatsApp.');
  END IF;
  UPDATE mensalidade_config SET liberado_ate = now() + interval '1 hour', atualizado_em = now()
   WHERE empresa_id = v_emp;
  INSERT INTO mensalidade_avisos (empresa_id, tipo, profile_id, quem, detalhe)
  SELECT v_emp, 'ja_paguei', p.id, p.nome || ' (' || p.perfil || ')', 'Disse que já pagou — liberado por 1 hora'
    FROM profiles p WHERE p.id = auth.uid()
  ON CONFLICT DO NOTHING;
  RETURN json_build_object('ok', true, 'liberado_ate', now() + interval '1 hour');
END;
$$;
GRANT EXECUTE ON FUNCTION public.mensalidade_ja_paguei() TO authenticated;

-- A situação passa a devolver a liberação temporária.
CREATE OR REPLACE FUNCTION public.mensalidade_situacao()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp    uuid := current_empresa_id();
  v_perfil text := current_perfil();
  v_cfg    mensalidade_config%ROWTYPE;
  v_hoje   date := (now() AT TIME ZONE 'America/Fortaleza')::date;
  v_admin  boolean;
BEGIN
  IF v_emp IS NULL THEN RETURN json_build_object('ativa', false); END IF;
  PERFORM mensalidade_gerar(v_emp);
  SELECT * INTO v_cfg FROM mensalidade_config WHERE empresa_id = v_emp;
  IF NOT FOUND OR NOT v_cfg.ativa THEN RETURN json_build_object('ativa', false); END IF;
  v_admin := v_perfil = 'admin';

  RETURN json_build_object(
    'ativa', true,
    'admin', v_admin,
    'hoje', v_hoje,
    'periodicidade', v_cfg.periodicidade,
    'carencia_dias', v_cfg.carencia_dias,
    'prazo_ate', v_cfg.prazo_ate,
    'liberado_ate', CASE WHEN v_cfg.liberado_ate > now() THEN v_cfg.liberado_ate END,
    'termo_aceito_em', CASE WHEN v_admin THEN v_cfg.termo_aceito_em END,
    'valor', CASE WHEN v_admin THEN v_cfg.valor END,
    'desconto_antecipado', CASE WHEN v_admin THEN v_cfg.desconto_antecipado END,
    'cartao', CASE WHEN v_admin AND v_cfg.mp_assinatura_id IS NOT NULL THEN json_build_object(
                'status', v_cfg.mp_assinatura_status, 'final', v_cfg.cartao_final, 'bandeira', v_cfg.cartao_bandeira) END,
    'mais_antiga_vencida', (SELECT min(vencimento) FROM mensalidade_cobrancas
                             WHERE empresa_id = v_emp AND status = 'aberta' AND vencimento <= v_hoje),
    'abertas', CASE WHEN v_admin THEN (SELECT coalesce(json_agg(json_build_object(
                  'id', id, 'vencimento', vencimento, 'referencia', referencia, 'valor', valor) ORDER BY vencimento), '[]'::json)
                FROM mensalidade_cobrancas WHERE empresa_id = v_emp AND status = 'aberta') END,
    'pagamento_pendente', CASE WHEN v_admin THEN (SELECT json_build_object(
                  'id', id, 'valor', valor, 'pix_copia_cola', pix_copia_cola, 'pix_qr_base64', pix_qr_base64, 'expira_em', expira_em)
                FROM mensalidade_pagamentos WHERE empresa_id = v_emp AND status = 'pendente' AND forma = 'pix'
                  AND (expira_em IS NULL OR expira_em > now()) ORDER BY created_at DESC LIMIT 1) END
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.mensalidade_situacao() TO authenticated;

-- Super ADM: gera as cobranças de todas as lojas antes de abrir o painel.
CREATE OR REPLACE FUNCTION public.mensalidade_atualizar_todas()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_perfil() <> 'super_admin' THEN RAISE EXCEPTION 'Só o Super ADM'; END IF;
  RETURN mensalidade_gerar_todas();
END;
$$;
GRANT EXECUTE ON FUNCTION public.mensalidade_atualizar_todas() TO authenticated;

NOTIFY pgrst, 'reload schema';
