-- =========================================================
-- Migration 0120 - Cadastro de loja passa a gravar CNPJ e companhia
-- =========================================================
-- Bug: o formulário de cadastro de loja (/entrar e /cadastro) sempre mandou
-- cnpj, razao_social, telefone e endereco no metadata do signup, mas o ramo
-- 'empresa' da handle_new_user só gravava o NOME da empresa. Tudo o mais era
-- descartado em silêncio — por isso quase nenhuma loja tem CNPJ no banco.
--
-- O CNPJ é o que identifica a loja nas integrações (o iFood pede o CNPJ pra
-- vincular o merchant ao nosso app), então ele precisa chegar no banco.
--
-- Só o ramo 'empresa' muda; os demais ficam idênticos.
-- =========================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tipo       text;
  v_empresa_id uuid;
  v_cliente_id uuid;
BEGIN
  v_tipo := new.raw_user_meta_data->>'tipo_cadastro';

  IF v_tipo = 'empresa' THEN
    INSERT INTO empresas (
      nome, status, plano, trial_fim,
      cnpj, razao_social, telefone_contato, endereco, nome_responsavel, email_contato
    )
    VALUES (
      COALESCE(new.raw_user_meta_data->>'nome_empresa', 'Minha empresa'),
      'trial', 'padrao', (now() + interval '14 days')::date,
      -- guarda só os dígitos do CNPJ (o front manda assim, mas cadastro antigo
      -- ou chamada direta pode vir formatado)
      NULLIF(REGEXP_REPLACE(COALESCE(new.raw_user_meta_data->>'cnpj', ''), '\D', '', 'g'), ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'razao_social', '')), ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'telefone', '')),     ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'endereco', '')),     ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'nome', '')),         ''),
      new.email
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
    INSERT INTO profiles (
      id, nome, email, perfil, telefone,
      cep, endereco, numero, complemento, bairro, cidade, estado, latitude, longitude
    )
    VALUES (
      new.id,
      COALESCE(new.raw_user_meta_data->>'nome', new.email),
      new.email,
      'cliente',
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'telefone', '')),    ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'cep', '')),         ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'endereco', '')),    ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'numero', '')),      ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'complemento', '')), ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'bairro', '')),      ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'cidade', '')),      ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'estado', '')),      ''),
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'latitude', '')),    '')::numeric,
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'longitude', '')),   '')::numeric
    )
    ON CONFLICT (id) DO NOTHING;

  ELSE
    NULL;
  END IF;

  RETURN new;
END;
$function$;
