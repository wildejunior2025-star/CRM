-- =========================================================
-- 0041: Completar cadastro de usuário que entrou via Google
-- =========================================================
-- Quem entra pelo Google cai no ramo ELSE de handle_new_user:
-- ganha só um profile (perfil='cliente') com nome/email, SEM
-- username, telefone, endereço nem patrocinador escolhido
-- (o trigger trg_set_ref_token já vincula à raiz por padrão).
--
-- Esta RPC permite que esse usuário (já autenticado) complete:
--   apelido (login), telefone, endereço e patrocinador.
-- A senha é definida no cliente via supabase.auth.updateUser().
--
-- Como trg_populate_arvore só roda no INSERT, aqui reconstruímos
-- a árvore de indicação deste usuário quando o patrocinador muda.
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
  v_uname   text := lower(trim(coalesce(p_username, '')));
  v_ref     text := nullif(trim(coalesce(p_ref_token, '')), '');
  v_sponsor uuid;
  v_current uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  -- Apelido (login) — obrigatório, formato e unicidade
  IF v_uname = '' THEN
    RAISE EXCEPTION 'Apelido é obrigatório';
  END IF;
  IF v_uname !~ '^[a-z0-9_.]{3,30}$' THEN
    RAISE EXCEPTION 'Apelido inválido: use 3 a 30 caracteres (letras, números, _ ou .)';
  END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE username = v_uname AND id <> v_uid) THEN
    RAISE EXCEPTION 'Este apelido já está em uso';
  END IF;

  -- Campos obrigatórios de contato/endereço
  IF nullif(trim(coalesce(p_telefone, '')), '') IS NULL THEN RAISE EXCEPTION 'Telefone é obrigatório'; END IF;
  IF nullif(trim(coalesce(p_endereco, '')), '') IS NULL THEN RAISE EXCEPTION 'Endereço (rua) é obrigatório'; END IF;
  IF nullif(trim(coalesce(p_numero,   '')), '') IS NULL THEN RAISE EXCEPTION 'Número é obrigatório'; END IF;
  IF nullif(trim(coalesce(p_estado,   '')), '') IS NULL THEN RAISE EXCEPTION 'Estado é obrigatório'; END IF;
  IF nullif(trim(coalesce(p_cidade,   '')), '') IS NULL THEN RAISE EXCEPTION 'Cidade é obrigatória'; END IF;
  IF nullif(trim(coalesce(p_bairro,   '')), '') IS NULL THEN RAISE EXCEPTION 'Bairro é obrigatório'; END IF;

  -- Resolve o patrocinador: token informado (válido) > raiz (link_raiz_token) > 1º super_admin
  IF v_ref IS NOT NULL THEN
    SELECT id INTO v_sponsor FROM profiles WHERE ref_token = v_ref AND id <> v_uid LIMIT 1;
  END IF;
  IF v_sponsor IS NULL THEN
    SELECT p.id INTO v_sponsor
    FROM profiles p
    JOIN configuracoes_plataforma cfg ON cfg.chave = 'link_raiz_token' AND cfg.valor = p.ref_token
    WHERE p.id <> v_uid
    LIMIT 1;
  END IF;
  IF v_sponsor IS NULL THEN
    SELECT id INTO v_sponsor FROM profiles
    WHERE perfil = 'super_admin' AND ref_token IS NOT NULL
    ORDER BY created_at ASC LIMIT 1;
  END IF;

  -- Atualiza os dados do perfil
  UPDATE profiles SET
    username    = v_uname,
    nome        = coalesce(nullif(trim(p_nome), ''), nome),
    telefone    = nullif(trim(p_telefone), ''),
    cep         = nullif(trim(p_cep), ''),
    endereco    = nullif(trim(p_endereco), ''),
    numero      = nullif(trim(p_numero), ''),
    complemento = nullif(trim(p_complemento), ''),
    bairro      = nullif(trim(p_bairro), ''),
    cidade      = nullif(trim(p_cidade), ''),
    estado      = nullif(trim(p_estado), '')
  WHERE id = v_uid;

  -- Se o patrocinador mudou, atualiza indicado_por e reconstrói a árvore deste usuário
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
