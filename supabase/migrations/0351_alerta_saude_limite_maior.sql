-- Migration 0351: alerta de saúde só quando é motivo de preocupação
--
-- Em 19/10 o WhatsApp avisou "Consumo subindo" às 11h00 por um pico de 10 min
-- (43,8 leituras/seg), que voltou sozinho. CPU em 5%, conexões 29/90: nada
-- estava perto de travar. O limite de 30 foi escolhido quando o normal era 3;
-- hoje o normal fica entre 3 e 10, e picos curtos de 40 são rotina.
--
-- Novo limite de leitura: atenção em 80/seg, perigo em 150/seg.
-- Conexões não mudam (65% / 85%). A tela do Super ADM usa os mesmos números.

CREATE OR REPLACE FUNCTION public.plataforma_saude_status()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a plataforma_saude_amostras%ROWTYPE;
  b plataforma_saude_amostras%ROWTYPE;
  segs numeric; taxa numeric := 0;
  pct_con numeric; max_con int;
  nivel text; motivo text := '';
BEGIN
  SELECT * INTO a FROM plataforma_saude_amostras ORDER BY medido_em DESC LIMIT 1;
  IF NOT FOUND THEN RETURN json_build_object('ok', false, 'erro', 'sem_amostra'); END IF;

  SELECT * INTO b FROM plataforma_saude_amostras
   WHERE medido_em < a.medido_em ORDER BY medido_em DESC LIMIT 1;
  IF FOUND THEN
    segs := extract(epoch FROM (a.medido_em - b.medido_em));
    IF segs > 0 AND a.leituras_profiles >= b.leituras_profiles THEN
      taxa := round((a.leituras_profiles - b.leituras_profiles) / segs, 1);
    END IF;
  END IF;

  max_con := (SELECT setting::int FROM pg_settings WHERE name='max_connections');
  pct_con := round(100.0 * a.conexoes / greatest(max_con, 1), 1);

  IF taxa >= 150 OR pct_con >= 85 THEN nivel := 'perigo';
  ELSIF taxa >= 80 OR pct_con >= 65 THEN nivel := 'atencao';
  ELSE nivel := 'ok'; END IF;

  IF taxa    >= 80 THEN motivo := motivo || format('leitura do banco em %s/seg; ', taxa); END IF;
  IF pct_con >= 65 THEN motivo := motivo || format('conexoes em %s%% (%s de %s); ', pct_con, a.conexoes, max_con); END IF;

  RETURN json_build_object(
    'ok', true, 'nivel', nivel,
    'motivo', nullif(trim(trailing '; ' from motivo), ''),
    'leitura_por_seg', taxa, 'conexoes', a.conexoes, 'conexoes_max', max_con,
    'pct_conexoes', pct_con,
    'banco_mb', round(pg_database_size(current_database()) / 1048576.0),
    'medido_em', a.medido_em);
END; $$;

REVOKE ALL ON FUNCTION public.plataforma_saude_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plataforma_saude_status() TO service_role;

-- Texto do aviso: "normal" hoje é até 10, não até 3.
CREATE OR REPLACE FUNCTION public.plataforma_saude_avisar()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  st json; v_nivel text; ant plataforma_saude_alerta%ROWTYPE;
  ordem int; ordem_ant int; manda boolean := false; texto text;
BEGIN
  IF coalesce((SELECT valor FROM config_global WHERE chave='saude_alerta_ativo'), 'true') = 'false' THEN
    RETURN json_build_object('enviar', false, 'motivo', 'desligado');
  END IF;

  st := plataforma_saude_status();
  IF (st->>'ok') <> 'true' THEN RETURN json_build_object('enviar', false, 'motivo', 'sem_dado'); END IF;

  v_nivel := st->>'nivel';
  SELECT * INTO ant FROM plataforma_saude_alerta WHERE id = 1;

  ordem     := CASE v_nivel   WHEN 'perigo' THEN 2 WHEN 'atencao' THEN 1 ELSE 0 END;
  ordem_ant := CASE ant.nivel WHEN 'perigo' THEN 2 WHEN 'atencao' THEN 1 ELSE 0 END;

  IF ordem > ordem_ant THEN manda := true;
  ELSIF ordem > 0 AND ordem = ordem_ant
        AND (ant.avisado_em IS NULL OR ant.avisado_em < now() - interval '6 hours') THEN manda := true;
  ELSIF ordem = 0 AND ordem_ant > 0 THEN manda := true;
  END IF;

  IF NOT manda THEN
    RETURN json_build_object('enviar', false, 'motivo', 'sem_mudanca', 'nivel', v_nivel);
  END IF;

  texto := CASE
    WHEN v_nivel = 'perigo' THEN
      '🚨 *Sistema no limite*' || chr(10) || chr(10) ||
      'O banco de dados está no teto. Se nada for feito, as lojas podem parar como em 23/09.' || chr(10) || chr(10) ||
      '*O que está alto:* ' || coalesce(st->>'motivo', 'consumo geral') || chr(10) ||
      'Leitura: ' || (st->>'leitura_por_seg') || '/seg (normal: até 10)' || chr(10) ||
      'Conexões: ' || (st->>'conexoes') || ' de ' || (st->>'conexoes_max')
    WHEN v_nivel = 'atencao' THEN
      '⚠️ *Consumo subindo*' || chr(10) || chr(10) ||
      'Ainda dá tempo de agir com calma.' || chr(10) || chr(10) ||
      '*O que subiu:* ' || coalesce(st->>'motivo', 'consumo geral') || chr(10) ||
      'Leitura: ' || (st->>'leitura_por_seg') || '/seg (normal: até 10)' || chr(10) ||
      'Conexões: ' || (st->>'conexoes') || ' de ' || (st->>'conexoes_max')
    ELSE
      '✅ *Sistema normalizou*' || chr(10) || chr(10) ||
      'Leitura: ' || (st->>'leitura_por_seg') || '/seg · Conexões: ' ||
      (st->>'conexoes') || ' de ' || (st->>'conexoes_max')
  END;

  UPDATE plataforma_saude_alerta SET nivel = v_nivel, avisado_em = now() WHERE id = 1;

  RETURN json_build_object('enviar', true, 'nivel', v_nivel, 'texto', texto,
    'telefone', (SELECT valor FROM config_global WHERE chave='saude_alerta_phone'));
END; $$;
