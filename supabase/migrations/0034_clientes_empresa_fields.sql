-- =========================================================
-- 0034: Campos de empresa no cadastro de clientes
-- =========================================================

-- 1. Adiciona razao_social (unica coluna que faltava).
--    cnpj_cpf, endereco, bairro, cidade: existem desde o schema original.
--    cep, numero, complemento: adicionados na 0032.
--    user_id: adicionado manualmente via painel — garantido aqui por seguranca.
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS razao_social text,
  ADD COLUMN IF NOT EXISTS user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- =========================================================
-- 2. Atualiza handle_new_user para, no fluxo tipo_cadastro='cliente',
--    criar o registro em clientes com os dados extras do metadata
--    (razao_social, cnpj_cpf, telefone, cep, endereco, numero,
--    complemento, bairro, cidade).
--
--    O INSERT em clientes precisa acontecer no trigger (SECURITY DEFINER)
--    porque o perfil 'cliente' não tem permissão de INSERT via RLS.
--    Após criar o profile, vinculamos client_id no profile também.
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
      'trial',
      'padrao',
      (now() + interval '14 days')::date
    )
    RETURNING id INTO v_empresa_id;

    INSERT INTO profiles (id, nome, email, perfil, empresa_id)
    VALUES (new.id, COALESCE(new.raw_user_meta_data->>'nome', new.email), new.email, 'admin', v_empresa_id)
    ON CONFLICT (id) DO NOTHING;

  ELSIF v_tipo = 'admin_empresa' AND (new.raw_user_meta_data->>'empresa_id') IS NOT NULL THEN
    INSERT INTO profiles (id, nome, email, perfil, empresa_id)
    VALUES (
      new.id,
      COALESCE(new.raw_user_meta_data->>'nome', new.email),
      new.email,
      'admin',
      (new.raw_user_meta_data->>'empresa_id')::uuid
    )
    ON CONFLICT (id) DO NOTHING;

  ELSIF v_tipo = 'vendedor' AND (new.raw_user_meta_data->>'empresa_id') IS NOT NULL THEN
    INSERT INTO profiles (id, nome, email, perfil, empresa_id)
    VALUES (
      new.id,
      COALESCE(new.raw_user_meta_data->>'nome', new.email),
      new.email,
      'vendedor',
      (new.raw_user_meta_data->>'empresa_id')::uuid
    )
    ON CONFLICT (id) DO NOTHING;

  ELSIF v_tipo = 'cliente' AND (new.raw_user_meta_data->>'empresa_id') IS NOT NULL THEN
    v_empresa_id := (new.raw_user_meta_data->>'empresa_id')::uuid;

    -- Cria o registro em clientes com todos os dados fornecidos no metadata.
    -- Feito aqui no trigger (SECURITY DEFINER) porque o perfil 'cliente'
    -- não tem permissão de INSERT via RLS na tabela clientes.
    INSERT INTO clientes (
      empresa_id,
      user_id,
      nome,
      razao_social,
      cnpj_cpf,
      telefone,
      cep,
      endereco,
      numero,
      complemento,
      bairro,
      cidade
    ) VALUES (
      v_empresa_id,
      new.id,
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

    -- Cria o profile 'cliente' já vinculando ao registro de clientes recém-criado.
    INSERT INTO profiles (id, nome, email, perfil, empresa_id, cliente_id)
    VALUES (
      new.id,
      COALESCE(new.raw_user_meta_data->>'nome', new.email),
      new.email,
      'cliente',
      v_empresa_id,
      v_cliente_id
    )
    ON CONFLICT (id) DO NOTHING;

  ELSE
    INSERT INTO profiles (id, nome, email, perfil)
    VALUES (new.id, COALESCE(new.raw_user_meta_data->>'nome', new.email), new.email, 'cliente')
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN new;
END;
$$;
