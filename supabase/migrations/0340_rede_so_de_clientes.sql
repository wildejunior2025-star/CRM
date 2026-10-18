-- A rede de indicação do aplicativo é SÓ de clientes (perfil 'cliente') + a raiz (super_admin).
-- Antes só admin/vendedor ficavam de fora, então funcionário (entregador, garçom, cozinheiro)
-- e aluno/professor da academia caíam como indicados diretos da raiz (445 nós no Mapa da Rede).
-- Nenhuma conta é apagada: só sai da rede. Backup dos vínculos antes de mexer.

CREATE TABLE IF NOT EXISTS public.backup_rede_indicacao_0340_arvore AS
  SELECT * FROM public.indicacao_arvore;
CREATE TABLE IF NOT EXISTS public.backup_rede_indicacao_0340_profiles AS
  SELECT id, perfil, indicado_por, ref_token FROM public.profiles;
ALTER TABLE public.backup_rede_indicacao_0340_arvore ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_rede_indicacao_0340_profiles ENABLE ROW LEVEL SECURITY;

-- Gatilhos: só cliente e super_admin participam
CREATE OR REPLACE FUNCTION public.fn_populate_arvore()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$
BEGIN
  IF NEW.perfil NOT IN ('cliente', 'super_admin') THEN
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

CREATE OR REPLACE FUNCTION public.fn_set_ref_token()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$
DECLARE
  v_tok      TEXT;
  v_referrer UUID;
BEGIN
  -- Só cliente e super_admin participam da rede: os demais não ganham ref_token nem indicado_por.
  IF NEW.perfil NOT IN ('cliente', 'super_admin') THEN
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

-- Limpeza: tira da rede quem não é cliente/raiz (a conta continua existindo)
DELETE FROM public.indicacao_arvore
 WHERE ancestor_id IN (SELECT id FROM public.profiles WHERE perfil NOT IN ('cliente','super_admin'))
    OR descendant_id IN (SELECT id FROM public.profiles WHERE perfil NOT IN ('cliente','super_admin'));

UPDATE public.profiles
   SET indicado_por = NULL
 WHERE perfil NOT IN ('cliente','super_admin') AND indicado_por IS NOT NULL;
