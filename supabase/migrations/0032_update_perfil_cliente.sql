-- =========================================================
-- 0032: Campos de endereço completo em clientes + RPC de perfil
-- =========================================================

-- 1. Garante que todos os campos de endereço existam na tabela clientes
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS cep         text,
  ADD COLUMN IF NOT EXISTS numero      text,
  ADD COLUMN IF NOT EXISTS complemento text;
-- (endereco, bairro e cidade já existem desde a criação original)

-- =========================================================
-- 2. RPC: update_perfil_cliente
-- Permite que o cliente autenticado atualize seus próprios dados
-- na tabela clientes (vinculados pelo user_id).
-- SECURITY DEFINER garante que a função executa com privilégios
-- do owner, permitindo o UPDATE mesmo sob RLS.
-- =========================================================
CREATE OR REPLACE FUNCTION update_perfil_cliente(
  p_nome        text,
  p_telefone    text,
  p_cep         text,
  p_endereco    text,
  p_numero      text,
  p_complemento text,
  p_bairro      text,
  p_cidade      text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Não autenticado';
  END IF;

  UPDATE clientes SET
    nome        = p_nome,
    telefone    = p_telefone,
    cep         = p_cep,
    endereco    = p_endereco,
    numero      = p_numero,
    complemento = p_complemento,
    bairro      = p_bairro,
    cidade      = p_cidade
  WHERE user_id = v_user_id;
END;
$$;
