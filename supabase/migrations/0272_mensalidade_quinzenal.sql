-- =========================================================
-- Migration 0272 - Mensalidade quinzenal (dia 1 e dia 15)
-- =========================================================
-- O Zebu pediu pra pagar em duas vezes no mês, dia 1 e dia 15, em vez de
-- toda semana (14/09/2026). Vira uma terceira periodicidade: "quinzenal".
--
-- Os vencimentos caem SEMPRE nos dias 1 e 15. O 1º vencimento configurado é
-- ajustado pro próximo dia 1 ou 15 (se cair num dia 7, vence no 15).
-- Pós-pago, igual à semanal: o dia 15 cobra de 01 a 14; o dia 1 cobra do 15
-- ao último dia do mês anterior.
-- =========================================================

ALTER TABLE public.mensalidade_config DROP CONSTRAINT IF EXISTS mensalidade_config_periodicidade_check;
ALTER TABLE public.mensalidade_config ADD CONSTRAINT mensalidade_config_periodicidade_check
  CHECK (periodicidade IN ('semanal', 'quinzenal', 'mensal'));

CREATE OR REPLACE FUNCTION public.mensalidade_gerar(p_empresa uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  IF v_cfg.periodicidade = 'quinzenal' THEN
    -- Encaixa no próximo dia 1 ou 15.
    IF extract(day FROM v_venc) > 15 THEN
      v_venc := (date_trunc('month', v_venc) + interval '1 month')::date;
    ELSIF extract(day FROM v_venc) NOT IN (1, 15) THEN
      v_venc := (date_trunc('month', v_venc) + interval '14 days')::date;
    END IF;
  END IF;

  WHILE v_venc <= v_hoje + 7 AND v_n < 520 LOOP
    IF v_cfg.periodicidade = 'semanal' THEN
      v_ref := 'Semana ' || to_char(v_venc - 7, 'DD/MM') || ' a ' || to_char(v_venc - 1, 'DD/MM');
    ELSIF v_cfg.periodicidade = 'quinzenal' THEN
      IF extract(day FROM v_venc) = 15 THEN
        v_ref := 'Quinzena ' || to_char(date_trunc('month', v_venc), 'DD/MM') || ' a ' || to_char(v_venc - 1, 'DD/MM');
      ELSE
        v_ref := 'Quinzena ' || to_char((v_venc - interval '1 month')::date + 14, 'DD/MM') || ' a ' || to_char(v_venc - 1, 'DD/MM');
      END IF;
    ELSE
      v_ref := 'Mês ' || to_char((v_venc - interval '1 month')::date, 'DD/MM') || ' a ' || to_char(v_venc - 1, 'DD/MM');
    END IF;
    INSERT INTO mensalidade_cobrancas (empresa_id, vencimento, referencia, valor)
    VALUES (p_empresa, v_venc, v_ref, v_cfg.valor)
    ON CONFLICT (empresa_id, vencimento) DO NOTHING;

    v_n := v_n + 1;
    IF v_cfg.periodicidade = 'semanal' THEN
      v_venc := v_cfg.inicio + (7 * v_n);
    ELSIF v_cfg.periodicidade = 'quinzenal' THEN
      IF extract(day FROM v_venc) = 1 THEN
        v_venc := v_venc + 14;                                              -- dia 1 → dia 15
      ELSE
        v_venc := (date_trunc('month', v_venc) + interval '1 month')::date; -- dia 15 → dia 1 do mês seguinte
      END IF;
    ELSE
      v_venc := (v_cfg.inicio + make_interval(months => v_n))::date;
    END IF;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.mensalidade_gerar(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mensalidade_gerar(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
