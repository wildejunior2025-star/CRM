-- =========================================================
-- Migration 0263 - Mensalidade semanal: cobrança, pagamento e prova de aviso
-- =========================================================
-- Decidido com o Wilde em 13/09/2026:
--   - cobrança semanal (ou mensal), cada loja com valor e dia próprios
--   - no dia do vencimento: só um aviso pro administrador
--   - depois de N dias EM QUE A LOJA ABRE (padrão 2), na abertura do dia
--     seguinte: pop-up fixo pro administrador, que só sai com pagamento, e
--     funcionário sem acesso. Pedido, iFood, Loja Online e robô seguem.
--   - PIX e cartão recorrente caem no Mercado Pago JURÍDICO da FWC
--   - tudo que foi mostrado ao lojista fica registrado (prova de aviso)
--
-- A configuração mora numa tabela própria, e não em `empresas`, porque o admin
-- da loja pode fazer UPDATE na própria empresa — e desligaria a cobrança.
-- A conta de "dias em que a loja abre" é feita no app e no robô com a grade,
-- os feriados e os dias marcados na mão (mesma regra de src/lib/feriados.js).
-- =========================================================

-- ── Configuração da cobrança por loja ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mensalidade_config (
  empresa_id          uuid PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  ativa               boolean      NOT NULL DEFAULT false,
  periodicidade       text         NOT NULL DEFAULT 'semanal' CHECK (periodicidade IN ('semanal', 'mensal')),
  valor               numeric(10,2) NOT NULL DEFAULT 0 CHECK (valor >= 0),
  -- Primeiro vencimento. Os seguintes andam de 7 em 7 dias (semanal) ou de mês
  -- em mês no mesmo dia (mensal).
  inicio              date,
  carencia_dias       smallint     NOT NULL DEFAULT 2 CHECK (carencia_dias BETWEEN 0 AND 30),
  desconto_antecipado numeric(10,2) NOT NULL DEFAULT 0 CHECK (desconto_antecipado >= 0),
  -- "Dar prazo": até esse dia (inclusive) o pop-up não trava.
  prazo_ate           date,
  prazo_motivo        text,
  termo_aceito_em     timestamptz,
  termo_aceito_por    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Assinatura no cartão (Mercado Pago preapproval).
  mp_assinatura_id    text,
  mp_assinatura_status text,
  cartao_final        text,
  cartao_bandeira     text,
  observacao          text,
  atualizado_em       timestamptz  NOT NULL DEFAULT now()
);

-- ── Cobranças (uma por semana/mês) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mensalidade_cobrancas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  vencimento   date NOT NULL,
  referencia   text NOT NULL,
  valor        numeric(10,2) NOT NULL,
  status       text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'paga', 'cancelada')),
  pago_em      timestamptz,
  valor_pago   numeric(10,2),
  forma        text,               -- pix | cartao | manual
  pagamento_id uuid,
  observacao   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, vencimento)
);
CREATE INDEX IF NOT EXISTS mensalidade_cobrancas_abertas_idx
  ON public.mensalidade_cobrancas (empresa_id, status, vencimento);

-- ── Pagamentos (um PIX pode quitar várias semanas) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.mensalidade_pagamentos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cobranca_ids   uuid[] NOT NULL DEFAULT '{}',
  valor          numeric(10,2) NOT NULL,
  forma          text NOT NULL DEFAULT 'pix',
  status         text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'cancelado')),
  mp_payment_id  text UNIQUE,
  pix_copia_cola text,
  pix_qr_base64  text,
  expira_em      timestamptz,
  aprovado_em    timestamptz,
  criado_por     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mensalidade_pagamentos_empresa_idx
  ON public.mensalidade_pagamentos (empresa_id, status, created_at DESC);

-- ── Prova de aviso ───────────────────────────────────────────────────────────
-- Cada coisa que o lojista viu ou recebeu: faixa, pop-up, bloqueio de
-- funcionário, WhatsApp, termo aceito, "já paguei", prazo dado, pagamento.
CREATE TABLE IF NOT EXISTS public.mensalidade_avisos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cobranca_id uuid REFERENCES public.mensalidade_cobrancas(id) ON DELETE SET NULL,
  tipo        text NOT NULL,
  profile_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  quem        text,
  detalhe     text,
  dia         date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Fortaleza')::date,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mensalidade_avisos_empresa_idx
  ON public.mensalidade_avisos (empresa_id, created_at DESC);
-- Uma linha por tipo, por pessoa, por dia: prova sem encher a tabela a cada F5.
CREATE UNIQUE INDEX IF NOT EXISTS mensalidade_avisos_um_por_dia
  ON public.mensalidade_avisos (empresa_id, tipo, dia, coalesce(profile_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(cobranca_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.mensalidade_config     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mensalidade_cobrancas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mensalidade_pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mensalidade_avisos     ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mensalidade_config', 'mensalidade_cobrancas', 'mensalidade_pagamentos', 'mensalidade_avisos']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_loja_ve', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_super_admin', t);
    -- Só o ADMIN da loja enxerga: funcionário não vê o valor da mensalidade.
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
      USING (empresa_id = current_empresa_id() AND current_perfil() = 'admin')$p$, t || '_loja_ve', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (current_perfil() = 'super_admin') WITH CHECK (current_perfil() = 'super_admin')$p$, t || '_super_admin', t);
  END LOOP;
END $$;

-- ── Gera as cobranças que já venceram (e a próxima, pra dar pra pagar antes) ─
CREATE OR REPLACE FUNCTION public.mensalidade_gerar(p_empresa uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cfg   mensalidade_config%ROWTYPE;
  v_hoje  date := (now() AT TIME ZONE 'America/Fortaleza')::date;
  v_venc  date;
  v_n     int := 0;
  v_ref   text;
BEGIN
  SELECT * INTO v_cfg FROM mensalidade_config WHERE empresa_id = p_empresa;
  IF NOT FOUND OR NOT v_cfg.ativa OR v_cfg.inicio IS NULL OR v_cfg.valor <= 0 THEN RETURN; END IF;

  v_venc := v_cfg.inicio;
  -- Até uma semana à frente: a próxima já aparece (desconto por pagar antes).
  WHILE v_venc <= v_hoje + 7 AND v_n < 520 LOOP
    IF v_cfg.periodicidade = 'semanal' THEN
      v_ref := 'Semana ' || to_char(v_venc - 7, 'DD/MM') || ' a ' || to_char(v_venc - 1, 'DD/MM');
    ELSE
      v_ref := 'Mês ' || to_char((v_venc - interval '1 month')::date, 'DD/MM') || ' a ' || to_char(v_venc - 1, 'DD/MM');
    END IF;
    INSERT INTO mensalidade_cobrancas (empresa_id, vencimento, referencia, valor)
    VALUES (p_empresa, v_venc, v_ref, v_cfg.valor)
    ON CONFLICT (empresa_id, vencimento) DO NOTHING;

    v_n := v_n + 1;
    IF v_cfg.periodicidade = 'semanal' THEN
      v_venc := v_cfg.inicio + (7 * v_n);
    ELSE
      v_venc := (v_cfg.inicio + make_interval(months => v_n))::date;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.mensalidade_gerar(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mensalidade_gerar(uuid) TO service_role;

-- ── Situação da loja do usuário logado ───────────────────────────────────────
-- Funcionário recebe só o que precisa pra saber se está bloqueado (sem valores).
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
    'termo_aceito_em', CASE WHEN v_admin THEN v_cfg.termo_aceito_em END,
    'valor', CASE WHEN v_admin THEN v_cfg.valor END,
    'desconto_antecipado', CASE WHEN v_admin THEN v_cfg.desconto_antecipado END,
    'cartao', CASE WHEN v_admin AND v_cfg.mp_assinatura_id IS NOT NULL THEN json_build_object(
                'status', v_cfg.mp_assinatura_status, 'final', v_cfg.cartao_final, 'bandeira', v_cfg.cartao_bandeira) END,
    -- Vencimento da cobrança aberta mais antiga que já venceu: é ela que conta os dias.
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

-- ── Registrar que o lojista viu/recebeu algo ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.mensalidade_registrar_aviso(p_tipo text, p_cobranca uuid DEFAULT NULL, p_detalhe text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp uuid := current_empresa_id();
BEGIN
  IF v_emp IS NULL OR p_tipo NOT IN ('faixa_vence_hoje', 'faixa_carencia', 'popup', 'bloqueio_funcionario', 'ja_paguei', 'pix_gerado') THEN
    RETURN;
  END IF;
  INSERT INTO mensalidade_avisos (empresa_id, cobranca_id, tipo, profile_id, quem, detalhe)
  SELECT v_emp, p_cobranca, p_tipo, p.id, p.nome || ' (' || p.perfil || ')', left(p_detalhe, 300)
    FROM profiles p WHERE p.id = auth.uid()
  ON CONFLICT DO NOTHING;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mensalidade_registrar_aviso(text, uuid, text) TO authenticated;

-- ── Termo aceito ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mensalidade_aceitar_termo()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_emp uuid := current_empresa_id();
BEGIN
  IF v_emp IS NULL OR current_perfil() <> 'admin' THEN RETURN; END IF;
  UPDATE mensalidade_config
     SET termo_aceito_em = now(), termo_aceito_por = auth.uid(), atualizado_em = now()
   WHERE empresa_id = v_emp AND termo_aceito_em IS NULL;
  INSERT INTO mensalidade_avisos (empresa_id, tipo, profile_id, quem, detalhe)
  SELECT v_emp, 'termo_aceito', p.id, p.nome || ' (' || p.perfil || ')', 'Li e concordo com as regras da mensalidade'
    FROM profiles p WHERE p.id = auth.uid()
  ON CONFLICT DO NOTHING;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mensalidade_aceitar_termo() TO authenticated;

-- ── Aplicar pagamento aprovado (Edge Function, com service role) ────────────
CREATE OR REPLACE FUNCTION public.mensalidade_aplicar_pagamento(p_pagamento uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pg mensalidade_pagamentos%ROWTYPE;
BEGIN
  SELECT * INTO v_pg FROM mensalidade_pagamentos WHERE id = p_pagamento FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_pg.status <> 'aprovado' THEN
    UPDATE mensalidade_pagamentos SET status = 'aprovado', aprovado_em = now() WHERE id = p_pagamento;
  END IF;
  UPDATE mensalidade_cobrancas
     SET status = 'paga', pago_em = coalesce(pago_em, now()), forma = v_pg.forma,
         pagamento_id = v_pg.id,
         valor_pago = round(v_pg.valor / greatest(array_length(v_pg.cobranca_ids, 1), 1), 2)
   WHERE id = ANY (v_pg.cobranca_ids) AND status = 'aberta';
  -- Pagou: o prazo dado não precisa mais segurar nada.
  UPDATE mensalidade_config SET prazo_ate = NULL, prazo_motivo = NULL, atualizado_em = now()
   WHERE empresa_id = v_pg.empresa_id
     AND NOT EXISTS (SELECT 1 FROM mensalidade_cobrancas c WHERE c.empresa_id = v_pg.empresa_id
                      AND c.status = 'aberta' AND c.vencimento <= (now() AT TIME ZONE 'America/Fortaleza')::date);
  INSERT INTO mensalidade_avisos (empresa_id, tipo, quem, detalhe)
  VALUES (v_pg.empresa_id, 'pagou', 'sistema', v_pg.forma || ' R$ ' || to_char(v_pg.valor, 'FM999990D00'))
  ON CONFLICT DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public.mensalidade_aplicar_pagamento(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mensalidade_aplicar_pagamento(uuid) TO service_role;

-- ── Super ADM: marcar como paga por fora (PIX direto, dinheiro) ──────────────
CREATE OR REPLACE FUNCTION public.mensalidade_marcar_paga(p_cobranca uuid, p_obs text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_c mensalidade_cobrancas%ROWTYPE;
BEGIN
  IF current_perfil() <> 'super_admin' THEN RAISE EXCEPTION 'Só o Super ADM'; END IF;
  UPDATE mensalidade_cobrancas
     SET status = 'paga', pago_em = now(), forma = 'manual', valor_pago = valor, observacao = p_obs
   WHERE id = p_cobranca AND status = 'aberta'
  RETURNING * INTO v_c;
  IF v_c.id IS NULL THEN RETURN; END IF;
  INSERT INTO mensalidade_avisos (empresa_id, cobranca_id, tipo, profile_id, quem, detalhe)
  VALUES (v_c.empresa_id, v_c.id, 'pagou', auth.uid(), 'Super ADM', 'Marcada como paga à mão' || coalesce(': ' || p_obs, ''))
  ON CONFLICT DO NOTHING;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mensalidade_marcar_paga(uuid, text) TO authenticated;

-- ── Cron diário: gera as cobranças de todas as lojas ativas ──────────────────
CREATE OR REPLACE FUNCTION public.mensalidade_gerar_todas()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT empresa_id FROM mensalidade_config WHERE ativa LOOP
    PERFORM mensalidade_gerar(r.empresa_id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.mensalidade_gerar_todas() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mensalidade_gerar_todas() TO service_role;

NOTIFY pgrst, 'reload schema';
