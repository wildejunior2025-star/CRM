-- =========================================================
-- 0035: Adiciona coluna telefone na tabela profiles
-- =========================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS telefone text;
