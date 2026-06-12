-- =========================================================
-- CRM Depósito de Bebidas - Migration 0011
-- Módulo: Foto e descrição nos produtos
-- =========================================================

-- ---------------------------------------------------------
-- Novos campos na tabela produtos
-- ---------------------------------------------------------
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS foto_url text;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS descricao text;

-- ---------------------------------------------------------
-- Recria a view estoque_catalogo incluindo foto_url e descricao.
-- A view original (criada fora das migrations) tem produto_id como
-- primeira coluna; usamos DROP + CREATE para evitar conflito de
-- ordem de colunas que impede CREATE OR REPLACE.
-- Mantém o join com empresas (filtragem por status da assinatura)
-- que já existia na view original.
-- ---------------------------------------------------------
DROP VIEW IF EXISTS estoque_catalogo;

CREATE VIEW estoque_catalogo AS
SELECT
  p.id          AS produto_id,
  p.empresa_id,
  e.nome        AS empresa_nome,
  p.nome,
  p.categoria,
  p.embalagem,
  p.unidades_por_caixa,
  p.preco_venda,
  p.estoque_minimo,
  p.controla_casco,
  p.foto_url,
  p.descricao,
  COALESCE(SUM(
    CASE
      WHEN m.tipo = 'entrada' THEN m.quantidade
      WHEN m.tipo = 'saida'   THEN -m.quantidade
      WHEN m.tipo = 'ajuste'  THEN m.quantidade
      ELSE 0
    END
  ), 0) AS quantidade_atual
FROM produtos p
JOIN empresas e
  ON e.id = p.empresa_id
  AND e.status = ANY(ARRAY['trial', 'ativo', 'atrasado'])
LEFT JOIN estoque_movimentos m
  ON m.produto_id = p.id AND m.empresa_id = p.empresa_id
WHERE p.ativo = true
GROUP BY
  p.id, p.empresa_id, e.nome,
  p.nome, p.categoria, p.embalagem,
  p.unidades_por_caixa, p.preco_venda, p.estoque_minimo,
  p.controla_casco, p.foto_url, p.descricao;

GRANT SELECT ON estoque_catalogo TO authenticated;
GRANT SELECT ON estoque_catalogo TO anon;

-- ---------------------------------------------------------
-- Storage bucket para fotos de produtos (público)
-- ---------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('produto-fotos', 'produto-fotos', true)
ON CONFLICT (id) DO NOTHING;

-- Policy: leitura pública (qualquer um pode ver as fotos)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'fotos_public_read'
  ) THEN
    CREATE POLICY "fotos_public_read" ON storage.objects
      FOR SELECT USING (bucket_id = 'produto-fotos');
  END IF;
END $$;

-- Policy: admin da empresa pode fazer upload
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'fotos_admin_upload'
  ) THEN
    CREATE POLICY "fotos_admin_upload" ON storage.objects
      FOR INSERT WITH CHECK (
        bucket_id = 'produto-fotos'
        AND current_perfil() = 'admin'
      );
  END IF;
END $$;

-- Policy: admin pode deletar
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename  = 'objects'
      AND policyname = 'fotos_admin_delete'
  ) THEN
    CREATE POLICY "fotos_admin_delete" ON storage.objects
      FOR DELETE USING (
        bucket_id = 'produto-fotos'
        AND current_perfil() = 'admin'
      );
  END IF;
END $$;
