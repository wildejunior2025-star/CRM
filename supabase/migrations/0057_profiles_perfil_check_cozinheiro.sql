-- =========================================================
-- 0057: permitir o perfil 'cozinheiro'
-- =========================================================
-- A cozinha também loga no app (só na Cozinha/KDS) para marcar os
-- pedidos como prontos. Adiciona 'cozinheiro' à constraint de perfil.
-- =========================================================
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_perfil_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_perfil_check
  CHECK (perfil = ANY (ARRAY['admin','vendedor','garcom','cozinheiro','cliente','super_admin']));
