-- =========================================================
-- 0051: coluna cargo (rótulo) em profiles
-- =========================================================
-- Campo opcional para rotular o funcionário (ex.: garçom/atendente).
-- Hoje o perfil já distingue 'garcom'; cargo fica para uso futuro
-- (rótulos finos, comissão por cargo, etc.).
-- =========================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cargo text;
