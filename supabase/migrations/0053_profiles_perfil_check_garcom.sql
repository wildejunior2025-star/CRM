-- =========================================================
-- 0053: permitir o perfil 'garcom' em profiles.perfil
-- =========================================================
-- A constraint só aceitava admin/vendedor/cliente/super_admin, então
-- marcar um funcionário como Garçom dava erro. Adiciona 'garcom'.
-- =========================================================
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_perfil_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_perfil_check
  CHECK (perfil = ANY (ARRAY['admin','vendedor','garcom','cliente','super_admin']));
