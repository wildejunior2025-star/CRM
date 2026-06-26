-- =========================================================
-- 0042: Usuário Google só é salvo no banco quando FINALIZA o cadastro
-- =========================================================
-- Antes: handle_new_user criava o profile já no clique do Google (ramo ELSE).
-- Agora: quando não há tipo_cadastro (login social/Google), NÃO cria profile.
-- O profile passa a ser criado só quando o usuário conclui o formulário
-- (RPC completar_cadastro_google vira UPSERT). Se ele desistir, nada fica salvo.
-- =========================================================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tipo       text;
  v_empresa_id uuid;
  v_cliente_id uuid;
BEGIN
  v_tipo := new.raw_user_meta_data->>'tipo_cadastro';

  IF v_tipo = 'empresa' THEN
    INSERT INTO empresas (nome, status, plano, trial_fim)
    VALUES (
      COALESCE(new.raw_user_meta_data->>'nome_empresa', 'Minha empresa'),
      'trial', 'padrao', (now() + interval '14 days')::date
    )
    RETURNING id INTO v_empresa_id;

    INSERT INTO profiles (id, nome, email, perfil, empresa_id)
    VALUES (new.id, COALESCE(new.raw_user_meta_data->>'nome', new.email), new.email, 'admin', v_empresa_id)
    ON CONFLICT (id) DO NOTHING;

  ELSIF v_tipo = 'admin_empresa' AND (new.raw_user_meta_data->>'empresa_id') IS NOT NULL THEN
    INSERT INTO profiles (id, nome, email, perfil, empresa_id)
    VALUES (new.id, COALESCE(new.raw_user_meta_data->>'nome', new.email), new.email, 'admin',
            (new.raw_user_meta_data->>'empresa_id')::uuid)
    ON CONFLICT (id) DO NOTHING;

  ELSIF v_tipo = 'vendedor' AND (new.raw_user_meta_data->>'empresa_id') IS NOT NULL THEN
    INSERT INTO profiles (id, nome, email, perfil, empresa_id)
    VALUES (new.id, COALESCE(new.raw_user_meta_data->>'nome', new.email), new.email, 'vendedor',
            (new.raw_user_meta_data->>'empresa_id')::uuid)
    ON CONFLICT (id) DO NOTHING;

  ELSIF v_tipo = 'cliente' AND (new.raw_user_meta_data->>'empresa_id') IS NOT NULL THEN
    v_empresa_id := (new.raw_user_meta_data->>'empresa_id')::uuid;

    INSERT INTO clientes (
      empresa_id, user_id, nome, razao_social, cnpj_cpf, telefone,
      cep, endereco, numero, complemento, bairro, cidade
    ) VALUES (
      v_empresa_id, new.id,
      COALESCE(new.raw_user_meta_data->>'nome', new.email),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'razao_social', '')), ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'cnpj_cpf', '')),    ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'telefone', '')),    ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'cep', '')),         ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'endereco', '')),    ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'numero', '')),      ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'complemento', '')), ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'bairro', '')),      ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'cidade', '')),      '')
    )
    RETURNING id INTO v_cliente_id;

    INSERT INTO profiles (id, nome, email, perfil, empresa_id, cliente_id)
    VALUES (new.id, COALESCE(new.raw_user_meta_data->>'nome', new.email), new.email, 'cliente', v_empresa_id, v_cliente_id)
    ON CONFLICT (id) DO NOTHING;

  ELSIF v_tipo = 'cliente' THEN
    -- Cliente do portal sem empresa (cadastro por e-mail/senha): cria o profile.
    INSERT INTO profiles (id, nome, email, perfil)
    VALUES (new.id, COALESCE(new.raw_user_meta_data->>'nome', new.email), new.email, 'cliente')
    ON CONFLICT (id) DO NOTHING;

  ELSE
    -- Login social/Google (sem tipo_cadastro): NÃO cria profile aqui.
    -- O cadastro só é gravado quando o usuário finaliza o formulário
    -- (completar_cadastro_google). Se desistir, nada fica salvo no banco.
    NULL;
  END IF;

  RETURN new;
END;
$$;

-- =========================================================
-- completar_cadastro_google agora é UPSERT: cria o profile se ainda
-- não existe (caso novo, login social) ou atualiza (Google antigo).
-- =========================================================
CREATE OR REPLACE FUNCTION completar_cadastro_google(
  p_username    text,
  p_nome        text,
  p_telefone    text,
  p_cep         text,
  p_endereco    text,
  p_numero      text,
  p_complemento text,
  p_bairro      text,
  p_cidade      text,
  p_estado      text,
  p_ref_token   text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_email   text;
  v_uname   text := lower(trim(coalesce(p_username, '')));
  v_ref     text := nullif(trim(coalesce(p_ref_token, '')), '');
  v_sponsor uuid;
  v_current uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Não autenticado'; END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

  IF v_uname = '' THEN RAISE EXCEPTION 'Apelido é obrigatório'; END IF;
  IF v_uname !~ '^[a-z0-9_.]{3,30}$' THEN
    RAISE EXCEPTION 'Apelido inválido: use 3 a 30 caracteres (letras, números, _ ou .)';
  END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE username = v_uname AND id <> v_uid) THEN
    RAISE EXCEPTION 'Este apelido já está em uso';
  END IF;

  IF nullif(trim(coalesce(p_telefone, '')), '') IS NULL THEN RAISE EXCEPTION 'Telefone é obrigatório'; END IF;
  IF nullif(trim(coalesce(p_endereco, '')), '') IS NULL THEN RAISE EXCEPTION 'Endereço (rua) é obrigatório'; END IF;
  IF nullif(trim(coalesce(p_numero,   '')), '') IS NULL THEN RAISE EXCEPTION 'Número é obrigatório'; END IF;
  IF nullif(trim(coalesce(p_estado,   '')), '') IS NULL THEN RAISE EXCEPTION 'Estado é obrigatório'; END IF;
  IF nullif(trim(coalesce(p_cidade,   '')), '') IS NULL THEN RAISE EXCEPTION 'Cidade é obrigatória'; END IF;
  IF nullif(trim(coalesce(p_bairro,   '')), '') IS NULL THEN RAISE EXCEPTION 'Bairro é obrigatório'; END IF;

  -- Cria (ou atualiza) o profile com todos os dados
  INSERT INTO profiles (id, nome, email, perfil, username, telefone, cep, endereco, numero, complemento, bairro, cidade, estado)
  VALUES (
    v_uid,
    coalesce(nullif(trim(p_nome), ''), v_email),
    v_email,
    'cliente',
    v_uname,
    nullif(trim(p_telefone), ''),
    nullif(trim(p_cep), ''),
    nullif(trim(p_endereco), ''),
    nullif(trim(p_numero), ''),
    nullif(trim(p_complemento), ''),
    nullif(trim(p_bairro), ''),
    nullif(trim(p_cidade), ''),
    nullif(trim(p_estado), '')
  )
  ON CONFLICT (id) DO UPDATE SET
    username    = excluded.username,
    nome        = coalesce(nullif(trim(p_nome), ''), profiles.nome),
    telefone    = excluded.telefone,
    cep         = excluded.cep,
    endereco    = excluded.endereco,
    numero      = excluded.numero,
    complemento = excluded.complemento,
    bairro      = excluded.bairro,
    cidade      = excluded.cidade,
    estado      = excluded.estado;

  -- Resolve patrocinador: token informado (válido) > raiz (link_raiz_token) > 1º super_admin
  IF v_ref IS NOT NULL THEN
    SELECT id INTO v_sponsor FROM profiles WHERE ref_token = v_ref AND id <> v_uid LIMIT 1;
  END IF;
  IF v_sponsor IS NULL THEN
    SELECT p.id INTO v_sponsor
    FROM profiles p
    JOIN configuracoes_plataforma cfg ON cfg.chave = 'link_raiz_token' AND cfg.valor = p.ref_token
    WHERE p.id <> v_uid LIMIT 1;
  END IF;
  IF v_sponsor IS NULL THEN
    SELECT id INTO v_sponsor FROM profiles
    WHERE perfil = 'super_admin' AND ref_token IS NOT NULL
    ORDER BY created_at ASC LIMIT 1;
  END IF;

  -- Vincula patrocinador e (re)constrói a árvore de indicação deste usuário
  SELECT indicado_por INTO v_current FROM profiles WHERE id = v_uid;
  IF v_sponsor IS NOT NULL AND v_sponsor <> v_uid AND v_sponsor IS DISTINCT FROM v_current THEN
    UPDATE profiles SET indicado_por = v_sponsor WHERE id = v_uid;

    DELETE FROM indicacao_arvore WHERE descendant_id = v_uid AND depth > 0;
    INSERT INTO indicacao_arvore (ancestor_id, descendant_id, depth)
    VALUES (v_uid, v_uid, 0) ON CONFLICT DO NOTHING;
    INSERT INTO indicacao_arvore (ancestor_id, descendant_id, depth)
    SELECT ia.ancestor_id, v_uid, ia.depth + 1
    FROM indicacao_arvore ia
    WHERE ia.descendant_id = v_sponsor AND ia.depth < 5
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION completar_cadastro_google(text,text,text,text,text,text,text,text,text,text,text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION completar_cadastro_google(text,text,text,text,text,text,text,text,text,text,text) TO authenticated;
