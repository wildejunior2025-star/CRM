-- Migration 0281: o sistema avisa no WhatsApp quando a saúde piora
--
-- A mig 0280 pôs as barras no Dashboard, mas barra só avisa quem está olhando.
-- Em 23/09 o sistema caiu às 10h40 e o dono só soube quando as lojas ligaram.
-- O sinal vinha subindo desde 20/09 — ninguém tinha motivo pra abrir o painel.
--
-- Agora o aviso vai atrás da pessoa.
--
-- POR QUE UMA CHAVE NOVA DE TELEFONE
-- `super_admin_phone` hoje aponta pro 5584999120349, que é o número da própria
-- plataforma. Os alertas de mensalidade usam essa chave e funcionam assim —
-- mexer nela mudaria o destino deles junto. Então o alerta de saúde ganha a
-- sua: remetente continua sendo a instância da plataforma, destino é o celular
-- do dono.
--
-- ANTI-REPETIÇÃO
-- Cron de 10 em 10 minutos com problema de 3 horas = 18 mensagens iguais. Aí a
-- pessoa silencia a conversa e o aviso seguinte, o que importa, não é lido.
-- Então: só manda quando o nível PIORA, ou quando passaram 6h no mesmo nível
-- ruim. Voltou pro verde, manda o "normalizou" uma vez e zera o controle.

INSERT INTO config_global (chave, valor)
VALUES ('saude_alerta_phone', '5584998180774')
ON CONFLICT (chave) DO NOTHING;

INSERT INTO config_global (chave, valor)
VALUES ('saude_alerta_ativo', 'true')
ON CONFLICT (chave) DO NOTHING;

-- Memória do último aviso, pra não repetir.
CREATE TABLE IF NOT EXISTS public.plataforma_saude_alerta (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- linha única
  nivel       text        NOT NULL DEFAULT 'ok',
  avisado_em  timestamptz,
  CONSTRAINT nivel_valido CHECK (nivel IN ('ok','atencao','perigo'))
);
INSERT INTO plataforma_saude_alerta (id) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE public.plataforma_saude_alerta ENABLE ROW LEVEL SECURITY;

-- ── Estado atual, para quem roda como service_role ───────────────────────────
-- `capacidade_sistema()` exige super_admin por auth.uid(), e o cron não tem
-- usuário logado. Esta é a mesma leitura, para máquina.
--
-- Os limites são os mesmos das barras do Dashboard, para o WhatsApp e a tela
-- nunca discordarem: 30/100 leituras por segundo, 65%/85% de conexões.
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

  IF taxa >= 100 OR pct_con >= 85 THEN
    nivel := 'perigo';
  ELSIF taxa >= 30 OR pct_con >= 65 THEN
    nivel := 'atencao';
  ELSE
    nivel := 'ok';
  END IF;

  IF taxa    >= 30 THEN motivo := motivo || format('leitura do banco em %s/seg; ', taxa); END IF;
  IF pct_con >= 65 THEN motivo := motivo || format('conexoes em %s%% (%s de %s); ', pct_con, a.conexoes, max_con); END IF;

  RETURN json_build_object(
    'ok', true,
    'nivel', nivel,
    'motivo', nullif(trim(trailing '; ' from motivo), ''),
    'leitura_por_seg', taxa,
    'conexoes', a.conexoes,
    'conexoes_max', max_con,
    'pct_conexoes', pct_con,
    'banco_mb', round(pg_database_size(current_database()) / 1048576.0),
    'medido_em', a.medido_em
  );
END;
$$;

REVOKE ALL ON FUNCTION public.plataforma_saude_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plataforma_saude_status() TO service_role;

-- ── Decide se é hora de avisar ───────────────────────────────────────────────
-- Devolve o texto da mensagem, ou null quando não há o que dizer. Já grava o
-- envio: quem chama só precisa mandar.
CREATE OR REPLACE FUNCTION public.plataforma_saude_avisar()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- `v_nivel` e não `nivel`: a tabela plataforma_saude_alerta tem coluna com
  -- esse nome, e no UPDATE lá embaixo os dois viram a mesma coisa pro parser.
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

  IF ordem > ordem_ant THEN
    manda := true;                                   -- piorou
  ELSIF ordem > 0 AND ordem = ordem_ant
        AND (ant.avisado_em IS NULL OR ant.avisado_em < now() - interval '6 hours') THEN
    manda := true;                                   -- continua ruim ha 6h
  ELSIF ordem = 0 AND ordem_ant > 0 THEN
    manda := true;                                   -- normalizou
  END IF;

  IF NOT manda THEN
    RETURN json_build_object('enviar', false, 'motivo', 'sem_mudanca', 'nivel', v_nivel);
  END IF;

  texto := CASE
    WHEN v_nivel = 'perigo' THEN
      '🚨 *Sistema no limite*' || chr(10) || chr(10) ||
      'O banco de dados está no teto. Se nada for feito, as lojas podem parar como em 23/09.' || chr(10) || chr(10) ||
      '*O que está alto:* ' || coalesce(st->>'motivo', 'consumo geral') || chr(10) ||
      'Leitura: ' || (st->>'leitura_por_seg') || '/seg (normal: até 3)' || chr(10) ||
      'Conexões: ' || (st->>'conexoes') || ' de ' || (st->>'conexoes_max')
    WHEN v_nivel = 'atencao' THEN
      '⚠️ *Consumo subindo*' || chr(10) || chr(10) ||
      'Ainda dá tempo de agir com calma.' || chr(10) || chr(10) ||
      '*O que subiu:* ' || coalesce(st->>'motivo', 'consumo geral') || chr(10) ||
      'Leitura: ' || (st->>'leitura_por_seg') || '/seg (normal: até 3)' || chr(10) ||
      'Conexões: ' || (st->>'conexoes') || ' de ' || (st->>'conexoes_max')
    ELSE
      '✅ *Sistema normalizou*' || chr(10) || chr(10) ||
      'Leitura: ' || (st->>'leitura_por_seg') || '/seg · Conexões: ' ||
      (st->>'conexoes') || ' de ' || (st->>'conexoes_max')
  END;

  UPDATE plataforma_saude_alerta SET nivel = v_nivel, avisado_em = now() WHERE id = 1;

  RETURN json_build_object(
    'enviar', true,
    'nivel', v_nivel,
    'texto', texto,
    'telefone', (SELECT valor FROM config_global WHERE chave='saude_alerta_phone')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.plataforma_saude_avisar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plataforma_saude_avisar() TO service_role;

-- ── Quem chama ───────────────────────────────────────────────────────────────
-- A cada 10 min. A função decide sozinha se há o que dizer, então rodar com
-- frequência não vira spam — na imensa maioria das vezes ela responde
-- "sem_mudanca" e não manda nada.
SELECT cron.schedule(
  'saude-alerta',
  '*/10 * * * *',
  $cron$ SELECT net.http_post(
       url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/saude-alerta',
       headers := '{"Content-Type":"application/json"}'::jsonb,
       body := '{}'::jsonb
     ); $cron$
);

-- A edge function vai deployada com verify_jwt = false: o gatilho do cron não
-- carrega JWT, e com verificação ligada ele levaria 401 calado (o caminho
-- manual continuaria funcionando, escondendo a falha).
