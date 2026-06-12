-- Adiciona campos de perfil visual à tabela empresas
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS banner_url text,
  ADD COLUMN IF NOT EXISTS descricao text;

-- Bucket público para banners e logos de empresas
INSERT INTO storage.buckets (id, name, public)
VALUES ('empresa-banners', 'empresa-banners', true)
ON CONFLICT DO NOTHING;

-- Leitura pública para qualquer um (portal de clientes)
CREATE POLICY "empresa-banners: leitura publica"
ON storage.objects FOR SELECT
TO anon
USING (bucket_id = 'empresa-banners');

-- Upload apenas para admin autenticado da própria empresa
-- O path deve ser empresa-banners/{empresa_id}/...
CREATE POLICY "empresa-banners: upload admin"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'empresa-banners'
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM empresas
    WHERE id = (
      SELECT empresa_id FROM profiles WHERE id = auth.uid()
    )
  )
  AND EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND perfil = 'admin'
  )
);

-- Update apenas para admin da própria empresa
CREATE POLICY "empresa-banners: update admin"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'empresa-banners'
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM empresas
    WHERE id = (
      SELECT empresa_id FROM profiles WHERE id = auth.uid()
    )
  )
  AND EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND perfil = 'admin'
  )
);

-- Delete apenas para admin da própria empresa
CREATE POLICY "empresa-banners: delete admin"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'empresa-banners'
  AND (storage.foldername(name))[1] IN (
    SELECT id::text FROM empresas
    WHERE id = (
      SELECT empresa_id FROM profiles WHERE id = auth.uid()
    )
  )
  AND EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND perfil = 'admin'
  )
);
