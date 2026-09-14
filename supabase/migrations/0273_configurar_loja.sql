-- Configurar Loja (onboarding da loja nova) — Fase 1, 14/09/2026.
--
-- Tela com as etapas que a loja precisa pra começar a vender, no modelo da
-- Brendi. Cada etapa se marca SOZINHA conferindo o banco; o que fica guardado
-- aqui é só o que o banco não sabe: etapa pulada, etapa marcada na mão (a
-- impressora mora no PC, não no banco) e quando a loja terminou.
--
-- Só loja NOVA é levada pra lá: as que já vendem nascem marcadas como
-- concluídas (legado) e acham a tela em Minha Loja, se quiserem.

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE empresas
   SET onboarding = jsonb_build_object('concluido_em', now(), 'legado', true)
 WHERE NOT (onboarding ? 'concluido_em');

-- Os fatos de cada etapa numa chamada só. SECURITY DEFINER porque parte deles
-- mora onde a loja não lê (mercadopago_contas guarda token).
CREATE OR REPLACE FUNCTION public.onboarding_status()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_emp uuid := current_empresa_id();
  e     empresas%ROWTYPE;
  w     whatsapp_config%ROWTYPE;
BEGIN
  IF v_emp IS NULL OR current_perfil() NOT IN ('admin', 'super_admin') THEN
    RETURN NULL;
  END IF;
  SELECT * INTO e FROM empresas WHERE id = v_emp;
  SELECT * INTO w FROM whatsapp_config WHERE empresa_id = v_emp;

  RETURN json_build_object(
    'onboarding', e.onboarding,
    'nome', e.nome,
    'slug', e.slug,
    'cnpj', e.cnpj,
    'razao_social', e.razao_social,
    'logo', coalesce(e.logo_url, '') <> '',
    'capa', coalesce(e.banner_url, '') <> '',
    'horario', EXISTS (
      SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.horarios_funcionamento) = 'array'
                                              THEN e.horarios_funcionamento ELSE '[]'::jsonb END) d
       WHERE (d->>'aberto')::boolean IS TRUE AND jsonb_array_length(coalesce(d->'periodos', '[]'::jsonb)) > 0),
    'pino', e.latitude IS NOT NULL AND e.longitude IS NOT NULL,
    'aceita_delivery', coalesce(e.aceita_delivery, false),
    'aceita_entrega', coalesce(e.aceita_entrega, true),
    'aceita_retirada', coalesce(e.aceita_retirada, false),
    'tem_taxa', coalesce(e.taxa_entrega, 0) > 0
             OR jsonb_array_length(CASE WHEN jsonb_typeof(e.taxas_entrega_km) = 'array' THEN e.taxas_entrega_km ELSE '[]'::jsonb END) > 0
             OR (jsonb_typeof(e.taxas_entrega_bairro) = 'array' AND jsonb_array_length(e.taxas_entrega_bairro) > 0)
             OR (jsonb_typeof(e.taxas_entrega_bairro) = 'object' AND e.taxas_entrega_bairro <> '{}'::jsonb),
    'formas_pagamento', coalesce(e.formas_pagamento, '[]'::jsonb),
    'mp_conectado', EXISTS (SELECT 1 FROM mercadopago_contas m WHERE m.empresa_id = v_emp) OR coalesce(e.mp_conectado, false),
    'chave_pix', coalesce(e.chave_pix, '') <> '',
    'produtos_ativos', (SELECT count(*) FROM produtos p WHERE p.empresa_id = v_emp AND p.ativo AND p.arquivado_em IS NULL),
    'produtos_com_foto', (SELECT count(*) FROM produtos p WHERE p.empresa_id = v_emp AND p.ativo AND p.arquivado_em IS NULL AND coalesce(p.foto_url, '') <> ''),
    'whatsapp_modulo', coalesce((e.modulos->>'whatsapp')::boolean, true),
    'whatsapp_conectado', coalesce(w.ativo, false) AND (coalesce(w.connected_phone, '') <> '' OR w.cloud_phone_number_id IS NOT NULL),
    'robo_ligado', coalesce(w.ia_ativo, false) OR coalesce(w.resposta_link_ativo, false),
    'pedidos', (SELECT count(*) FROM pedidos_delivery d WHERE d.empresa_id = v_emp),
    'delivery_ativo', coalesce(e.delivery_ativo, false),
    'pausada_manual', NOT coalesce(e.delivery_ativo, false) AND e.delivery_fechado_por IS DISTINCT FROM 'horario'
  );
END;
$function$;

-- Pular, marcar feito na mão, desfazer e concluir. Mexe só no jsonb da própria
-- loja, sem abrir o UPDATE da tabela inteira pra isso.
--   p_acao: 'pular' | 'feito' | 'desfazer' | 'concluir' | 'reabrir'
CREATE OR REPLACE FUNCTION public.onboarding_marcar(p_acao text, p_etapa text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_emp uuid := current_empresa_id();
  v_ob  jsonb;
BEGIN
  IF v_emp IS NULL OR current_perfil() NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'sem permissão';
  END IF;
  SELECT onboarding INTO v_ob FROM empresas WHERE id = v_emp FOR UPDATE;
  v_ob := coalesce(v_ob, '{}'::jsonb);

  IF p_acao IN ('pular', 'feito', 'desfazer') AND coalesce(p_etapa, '') = '' THEN
    RAISE EXCEPTION 'etapa obrigatória';
  END IF;

  -- Tira a etapa das duas listas antes de pôr na certa.
  IF p_acao IN ('pular', 'feito', 'desfazer') THEN
    v_ob := jsonb_set(v_ob, '{pulados}', coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(coalesce(v_ob->'pulados', '[]'::jsonb)) x WHERE x <> p_etapa), '[]'::jsonb));
    v_ob := jsonb_set(v_ob, '{feitos}',  coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(coalesce(v_ob->'feitos',  '[]'::jsonb)) x WHERE x <> p_etapa), '[]'::jsonb));
  END IF;

  IF p_acao = 'pular' THEN
    v_ob := jsonb_set(v_ob, '{pulados}', (v_ob->'pulados') || to_jsonb(p_etapa));
  ELSIF p_acao = 'feito' THEN
    v_ob := jsonb_set(v_ob, '{feitos}', (v_ob->'feitos') || to_jsonb(p_etapa));
  ELSIF p_acao = 'concluir' THEN
    v_ob := jsonb_set(v_ob, '{concluido_em}', to_jsonb(now()));
  ELSIF p_acao = 'reabrir' THEN
    v_ob := v_ob - 'concluido_em';
  ELSIF p_acao <> 'desfazer' THEN
    RAISE EXCEPTION 'ação inválida';
  END IF;

  UPDATE empresas SET onboarding = v_ob WHERE id = v_emp;
  RETURN v_ob;
END;
$function$;

REVOKE ALL ON FUNCTION public.onboarding_status() FROM anon;
REVOKE ALL ON FUNCTION public.onboarding_marcar(text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.onboarding_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_marcar(text, text) TO authenticated;
