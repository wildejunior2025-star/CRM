-- =========================================================
-- 0044: Loja não participa da rede de indicações
-- =========================================================
-- Decisão: loja (perfil admin/vendedor) NÃO indica cliente e NÃO
-- entra na árvore de indicação (Mapa da Rede). Loja nova = só loja.
-- Apenas perfis 'cliente' e a raiz 'super_admin' participam da rede.
--
-- Gating adicionado em dois triggers de profiles:
--   fn_set_ref_token   (BEFORE INSERT) — não gera ref_token/indicado_por p/ loja
--   fn_populate_arvore (AFTER INSERT)  — não insere loja na indicacao_arvore
-- =========================================================

CREATE OR REPLACE FUNCTION public.fn_set_ref_token()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_tok      TEXT;
  v_referrer UUID;
BEGIN
  -- Lojas não participam da rede: sem ref_token, sem indicado_por.
  IF NEW.perfil IN ('admin', 'vendedor') THEN
    RETURN NEW;
  END IF;

  IF NEW.ref_token IS NULL THEN
    LOOP
      v_tok := lower(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      EXIT WHEN NOT EXISTS (SELECT 1 FROM profiles WHERE ref_token = v_tok);
    END LOOP;
    NEW.ref_token := v_tok;
  END IF;

  SELECT p.id INTO v_referrer
  FROM profiles p
  WHERE p.ref_token = (SELECT raw_user_meta_data->>'ref_by_token' FROM auth.users WHERE id = NEW.id)
    AND p.id != NEW.id
  LIMIT 1;

  IF v_referrer IS NULL THEN
    SELECT p.id INTO v_referrer
    FROM profiles p
    JOIN configuracoes_plataforma cfg ON cfg.chave = 'link_raiz_token' AND cfg.valor = p.ref_token
    WHERE p.id != NEW.id
    LIMIT 1;
  END IF;

  IF v_referrer IS NOT NULL THEN
    NEW.indicado_por := v_referrer;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_populate_arvore()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  -- Lojas não entram na árvore de indicação.
  IF NEW.perfil IN ('admin', 'vendedor') THEN
    RETURN NEW;
  END IF;

  INSERT INTO indicacao_arvore (ancestor_id, descendant_id, depth)
  VALUES (NEW.id, NEW.id, 0) ON CONFLICT DO NOTHING;

  IF NEW.indicado_por IS NOT NULL THEN
    INSERT INTO indicacao_arvore (ancestor_id, descendant_id, depth)
    SELECT ia.ancestor_id, NEW.id, ia.depth + 1
    FROM indicacao_arvore ia
    WHERE ia.descendant_id = NEW.indicado_por AND ia.depth < 5
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;
