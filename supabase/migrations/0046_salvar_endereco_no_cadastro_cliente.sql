-- =========================================================
-- 0046: Cliente do portal (sem empresa) salva endereço no cadastro
-- =========================================================
-- BUG: no handle_new_user, o ramo "cliente sem empresa" gravava só
-- nome/email/perfil e DESCARTAVA telefone + endereço enviados no
-- cadastro (CadastroCliente). O cliente preenchia tudo e o endereço
-- não ficava salvo. Agora o INSERT persiste telefone e o endereço
-- completo (cep, rua, número, complemento, bairro, cidade, estado).
-- Os demais ramos do trigger ficam idênticos ao 0042.
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
    -- Cliente do portal sem empresa (cadastro por e-mail/senha):
    -- cria o profile JÁ COM telefone e endereço completo.
    INSERT INTO profiles (
      id, nome, email, perfil, telefone,
      cep, endereco, numero, complemento, bairro, cidade, estado
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
      NULLIF(TRIM(COALESCE(new.raw_user_meta_data->>'estado', '')),      '')
    )
    ON CONFLICT (id) DO NOTHING;

  ELSE
    -- Login social/Google (sem tipo_cadastro): NÃO cria profile aqui.
    NULL;
  END IF;

  RETURN new;
END;
$$;
