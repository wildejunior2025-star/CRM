-- =========================================================
-- Migration 0262 - Dia "aberto" sem horário na grade é dia FECHADO
-- =========================================================
-- A CDBom tinha o domingo salvo como {"aberto": true, "periodos": []}. O robô
-- do WhatsApp lia fechado ("Voltamos segunda às 08:30"), mas a Loja Online e
-- esta função liam "aberto o dia todo" — e às 13:22 de domingo, 13/09/2026,
-- entrou um pedido de cliente de verdade numa loja fechada.
--
-- Regra única agora, igual em src/lib/feriados.js e no robô:
--   - grade da semana: dia sem faixa de horário = fechado
--   - dia marcado na mão (dias_excecao) como aberto e sem horário = vale a
--     grade do dia; se ela também não tiver, aberto o dia todo (é o dono
--     dizendo "hoje abre")
--   - loja sem grade nenhuma continua sem trava
-- =========================================================
CREATE OR REPLACE FUNCTION public.loja_aberta_agora(p_empresa uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dia     date      := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_hora    text      := to_char((now() AT TIME ZONE 'America/Sao_Paulo'), 'HH24:MI');
  v_grade   jsonb;
  v_exc     record;
  v_periodos jsonb;
  v_p       jsonb;
BEGIN
  SELECT horarios_funcionamento INTO v_grade FROM empresas WHERE id = p_empresa;

  -- Exceção da data manda mais que a grade (mig 0142: feriado que fecha OU abre).
  SELECT aberto, periodos INTO v_exc
  FROM dias_excecao WHERE empresa_id = p_empresa AND data = v_dia;

  IF FOUND THEN
    IF NOT COALESCE(v_exc.aberto, false) THEN RETURN false; END IF;
    v_periodos := COALESCE(v_exc.periodos, '[]'::jsonb);
    -- Exceção "abre" sem horário definido: vale a grade do dia.
    IF jsonb_array_length(v_periodos) = 0 THEN
      v_periodos := COALESCE(v_grade -> EXTRACT(dow FROM v_dia)::int -> 'periodos', '[]'::jsonb);
    END IF;
    -- Nem a grade tem horário: o dono abriu o dia, vale o dia todo.
    IF jsonb_array_length(v_periodos) = 0 THEN RETURN true; END IF;
  ELSE
    IF v_grade IS NULL THEN RETURN true; END IF;   -- loja sem grade: não trava ninguém
    IF NOT COALESCE((v_grade -> EXTRACT(dow FROM v_dia)::int ->> 'aberto')::boolean, false) THEN
      RETURN false;
    END IF;
    v_periodos := COALESCE(v_grade -> EXTRACT(dow FROM v_dia)::int -> 'periodos', '[]'::jsonb);
    -- "Aberto" sem nenhuma faixa de horário é dia fechado (antes: o dia todo).
    IF jsonb_array_length(v_periodos) = 0 THEN RETURN false; END IF;
  END IF;

  FOR v_p IN SELECT * FROM jsonb_array_elements(v_periodos)
  LOOP
    CONTINUE WHEN coalesce(v_p->>'i', '') = '' OR coalesce(v_p->>'f', '') = '';
    -- Vira o dia (ex.: 18:00 às 02:00): vale se está depois de abrir OU antes de fechar.
    IF (v_p->>'f') < (v_p->>'i') THEN
      IF v_hora >= (v_p->>'i') OR v_hora <= (v_p->>'f') THEN RETURN true; END IF;
    ELSIF v_hora >= (v_p->>'i') AND v_hora <= (v_p->>'f') THEN
      RETURN true;
    END IF;
  END LOOP;

  RETURN false;
END;
$function$;

-- Grade já salva com dia "aberto" e sem horário vira fechada de vez, pra tela
-- de horários mostrar o que o sistema faz.
UPDATE empresas e
   SET horarios_funcionamento = (
     SELECT jsonb_agg(
              CASE WHEN (d->>'aberto')::boolean
                        AND jsonb_array_length(coalesce(d->'periodos', '[]'::jsonb)) = 0
                   THEN jsonb_build_object('aberto', false, 'periodos', '[]'::jsonb)
                   ELSE d END
              ORDER BY i)
       FROM jsonb_array_elements(e.horarios_funcionamento) WITH ORDINALITY AS t(d, i))
 WHERE jsonb_typeof(e.horarios_funcionamento) = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(e.horarios_funcionamento) d
      WHERE (d->>'aberto')::boolean
        AND jsonb_array_length(coalesce(d->'periodos', '[]'::jsonb)) = 0);
