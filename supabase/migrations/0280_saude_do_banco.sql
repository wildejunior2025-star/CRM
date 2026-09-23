-- Migration 0280: "Capacidade do sistema" passa a vigiar o banco também
--
-- POR QUE EXISTE
-- Em 23/09/2026, ~10h40, o sistema parou inteiro no almoço: gestor não abria,
-- loja não lançava pedido na mesa, pedido do iFood não aparecia. Levou ~40 min
-- pra achar a causa, e só achou porque alguém foi cavar no painel do Supabase.
--
-- O sinal estava lá havia dias: a CPU do banco saiu de 32% (20/09) para 99%
-- (23/09). Ninguém viu, porque o medidor de capacidade olhava bot, IA, lojas e
-- espaço em disco — e o que derrubou não foi nenhum dos quatro.
--
-- O painel do Supabase não avisa a tempo: com Spend Cap ligado ele derruba o
-- projeto e manda e-mail depois; desligado, só cobra, calado. Nos dois casos o
-- lojista descobre pela loja parada.
--
-- O QUE ENTRA E POR QUÊ
--
-- `leitura_por_seg` — velocidade com que a RLS relê a tabela `profiles`. Foi o
--     sintoma que denunciou tudo: as policies chamavam current_perfil() uma vez
--     por LINHA, então ler 100 pedidos custava ~1.200 idas a `profiles`. Medido
--     em 2h de movimento normal: 145 leituras/seg, com 5 lojas e 31 pedidos.
--     Depois do conserto (migs 0278/0279): menos de 3.
--     Serve de duas formas: avisa se a carga crescer, e denuncia policy nova
--     nascida sem `(select ...)` — o número dispara na hora.
--     Limites: 30/seg amarelo (10x o normal de hoje), 100/seg vermelho.
--
-- `conexoes` — encheu, ninguém entra. No dia da queda estava em 34 de 60.
--
-- COMO A TAXA É CALCULADA
-- `pg_stat_user_tables` dá contador ACUMULADO, não velocidade. Contador sozinho
-- não diz nada ("1,4 milhão" é muito ou pouco?). Então guardamos uma foto de
-- tempos em tempos e comparamos com a anterior: a diferença dividida pelos
-- segundos é a taxa.
--
-- Os contadores zeram quando o projeto reinicia. Foto menor que a anterior =
-- reinício no meio; nesse caso devolve 0 em vez de número negativo.

CREATE TABLE IF NOT EXISTS public.plataforma_saude_amostras (
  id                bigserial   PRIMARY KEY,
  medido_em         timestamptz NOT NULL DEFAULT now(),
  leituras_profiles bigint      NOT NULL,
  conexoes          int         NOT NULL
);

COMMENT ON TABLE public.plataforma_saude_amostras IS
  'Fotos periódicas dos contadores do banco; a taxa sai da diferença entre duas fotos (mig 0280).';

CREATE INDEX IF NOT EXISTS idx_saude_amostras_data
  ON public.plataforma_saude_amostras (medido_em DESC);

-- Sem policy de SELECT: ninguém lê direto, só pela capacidade_sistema(),
-- que já exige super_admin.
ALTER TABLE public.plataforma_saude_amostras ENABLE ROW LEVEL SECURITY;

-- ── Tira uma foto ────────────────────────────────────────────────────────────
-- Chamada pelo cron. Guarda 2 dias e descarta o resto: isto é termômetro,
-- não histórico.
CREATE OR REPLACE FUNCTION public.plataforma_saude_coletar()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO plataforma_saude_amostras (leituras_profiles, conexoes)
  SELECT
    coalesce((SELECT idx_scan FROM pg_stat_user_tables
               WHERE schemaname='public' AND relname='profiles'), 0),
    (SELECT count(*) FROM pg_stat_activity);

  DELETE FROM plataforma_saude_amostras WHERE medido_em < now() - interval '2 days';
END;
$$;

REVOKE ALL ON FUNCTION public.plataforma_saude_coletar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plataforma_saude_coletar() TO service_role;

-- ── A função que o Dashboard já chama, agora com as duas medidas novas ───────
-- Mantém as 4 métricas existentes intactas — a tela só ganha barras.
CREATE OR REPLACE FUNCTION public.capacidade_sistema()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  resultado json;
  a plataforma_saude_amostras%ROWTYPE;
  b plataforma_saude_amostras%ROWTYPE;
  segs  numeric;
  taxa  numeric := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = (SELECT auth.uid()) AND perfil = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO a FROM plataforma_saude_amostras ORDER BY medido_em DESC LIMIT 1;
  IF FOUND THEN
    SELECT * INTO b FROM plataforma_saude_amostras
     WHERE medido_em < a.medido_em ORDER BY medido_em DESC LIMIT 1;
    IF FOUND THEN
      segs := extract(epoch FROM (a.medido_em - b.medido_em));
      -- Contador menor = reiniciou no meio. Sem taxa, em vez de negativo.
      IF segs > 0 AND a.leituras_profiles >= b.leituras_profiles THEN
        taxa := round((a.leituras_profiles - b.leituras_profiles) / segs, 1);
      END IF;
    END IF;
  END IF;

  SELECT json_build_object(
    'bot_conversas_ativas', (
      SELECT count(DISTINCT phone) FROM whatsapp_conversas
      WHERE created_at > now() - interval '10 minutes'
    ),
    'ia_por_minuto', (
      SELECT count(*) FROM whatsapp_conversas
      WHERE role = 'assistant' AND created_at > now() - interval '1 minute'
    ),
    'lojas_bot_ativo', (
      SELECT count(*) FROM whatsapp_config w
        JOIN empresas e ON e.id = w.empresa_id
       WHERE w.ativo
         AND (w.ia_ativo OR w.resposta_link_ativo)
         AND e.status IN ('ativo', 'trial', 'atrasado')
    ),
    'banco_mb', (
      SELECT round(pg_database_size(current_database()) / 1024.0 / 1024.0)
    ),
    -- Novas (mig 0280)
    'leitura_por_seg', taxa,
    'conexoes',        coalesce(a.conexoes, 0),
    'conexoes_max',    (SELECT setting::int FROM pg_settings WHERE name='max_connections')
  ) INTO resultado;

  RETURN resultado;
END;
$$;

-- ── Coleta automática ────────────────────────────────────────────────────────
-- A cada 5 min: janela curta o bastante pra flagrar disparada no mesmo almoço,
-- longa o bastante pra não virar ela própria uma fonte de carga.
SELECT cron.schedule(
  'saude-banco-coletar',
  '*/5 * * * *',
  $$ SELECT public.plataforma_saude_coletar(); $$
);

-- Duas fotos já, pra tela não abrir zerada esperando o cron.
SELECT public.plataforma_saude_coletar();
