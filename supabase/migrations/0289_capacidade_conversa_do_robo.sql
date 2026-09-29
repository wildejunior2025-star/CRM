-- =========================================================
-- Migration 0289 - Capacidade: "Conversas no bot" não conta a loja falando
-- =========================================================
-- 29/09/2026: o medidor apontava 30/10 no vermelho com o robô parado. Quem
-- estava falando era a CDBom, do celular dela: um aviso ("Estaremos fechados
-- no dia 03.10") disparado pra 55 números em 10 minutos.
--
-- A mensagem que a loja manda do celular é espelhada em whatsapp_conversas
-- como role='assistant' com origem='loja' (whatsapp-cloud/index.ts) — é o que
-- faz a conversa aparecer no gestor. Só que as duas barras contavam ela:
--   - "Conversas no bot" contava todo número que apareceu na tabela, então
--     cada contato do disparo virava um "atendimento";
--   - "IA por minuto" contava todo assistant, então resposta digitada por
--     gente no balcão entrava como se fosse a IA.
--
-- Agora as duas ignoram origem='loja', e conversa ativa é número que falou
-- com o sistema (role='user') ou que o robô respondeu.
--
-- Limite novo, medido em 7 dias (417 janelas de 10 min): pico real do robô 12
-- conversas, média 3,5. O teto de 10 já estourava no movimento normal. 40 é
-- mais de três vezes o pico e conversa com o gargalo de verdade, que é a barra
-- de IA por minuto (50/min) — a barra de conversas é só o aviso que vem antes.
-- =========================================================
CREATE OR REPLACE FUNCTION public.capacidade_sistema()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  resultado json;
  a         plataforma_saude_amostras%ROWTYPE;
  b         plataforma_saude_amostras%ROWTYPE;
  segs      numeric;
  taxa      numeric := NULL;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND perfil = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Leituras de permissão por segundo: diferença entre as duas últimas fotos.
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
    -- Conversa de verdade: o cliente falou, ou o robô respondeu. Mensagem que
    -- a loja mandou do celular (origem='loja') não é atendimento do robô.
    'bot_conversas_ativas', (
      SELECT count(DISTINCT phone) FROM whatsapp_conversas
      WHERE created_at > now() - interval '10 minutes'
        AND (role = 'user' OR origem IS DISTINCT FROM 'loja')
    ),
    'ia_por_minuto', (
      SELECT count(*) FROM whatsapp_conversas
      WHERE role = 'assistant' AND origem IS DISTINCT FROM 'loja'
        AND created_at > now() - interval '1 minute'
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
    'leitura_por_seg', taxa,
    'conexoes',        coalesce(a.conexoes, 0),
    'conexoes_max',    (SELECT setting::int FROM pg_settings WHERE name='max_connections')
  ) INTO resultado;

  RETURN resultado;
END;
$function$;
