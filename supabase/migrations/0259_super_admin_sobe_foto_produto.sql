-- =========================================================
-- 0259: o super admin também sobe foto de produto
-- =========================================================
-- A política fotos_admin_upload só deixa o perfil 'admin' (o dono da loja)
-- subir no bucket produto-fotos. O super admin monta cardápio e combo pras
-- lojas (ex.: o combo de picolé da CDBom) e ficava travado na foto.
-- Só INSERT: apagar e trocar continuam com o dono da loja.
-- =========================================================

DROP POLICY IF EXISTS fotos_super_admin_upload ON storage.objects;
CREATE POLICY fotos_super_admin_upload ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'produto-fotos' AND current_perfil() = 'super_admin');
