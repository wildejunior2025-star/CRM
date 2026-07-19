-- =========================================================
-- 0107: Ficha Técnica (custo de produção por matéria-prima)
-- =========================================================
-- materias_primas → insumos que NÃO vão pro catálogo (farinha, frango...),
--                   com o custo por unidade base (ex.: R$/kg).
-- fichas_tecnicas → a "receita" de um produto (ex.: Coxinha): quanto rendeu
--                   pronto e o peso de cada porção → custo por porção.
-- ficha_itens     → as matérias-primas usadas na receita (com quantidade).
-- Vínculo opcional com produtos(id) pra mostrar a margem (custo x preço venda).
-- RLS por empresa (mesmo padrão de comandas/mesas).
-- =========================================================

CREATE TABLE IF NOT EXISTS materias_primas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  unidade     text NOT NULL DEFAULT 'kg',   -- kg | g | L | ml | un
  custo       numeric NOT NULL DEFAULT 0,   -- custo por 1 unidade acima (ex.: R$/kg)
  ativo       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fichas_tecnicas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome            text NOT NULL,
  produto_id      uuid REFERENCES produtos(id) ON DELETE SET NULL,  -- vínculo p/ margem
  rendimento      numeric NOT NULL DEFAULT 0,   -- quanto rendeu depois de pronto
  unid_rendimento text NOT NULL DEFAULT 'g',    -- g | kg | ml | L | un
  peso_porcao     numeric NOT NULL DEFAULT 0,   -- peso/tamanho de 1 porção final (ex.: 100 g)
  unid_porcao     text NOT NULL DEFAULT 'g',    -- g | kg | ml | L | un
  observacoes     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ficha_itens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  ficha_id         uuid NOT NULL REFERENCES fichas_tecnicas(id) ON DELETE CASCADE,
  materia_prima_id uuid REFERENCES materias_primas(id) ON DELETE SET NULL,
  nome             text NOT NULL,               -- snapshot do nome (se a MP for apagada)
  quantidade       numeric NOT NULL DEFAULT 0,
  unidade          text NOT NULL DEFAULT 'g',   -- unidade usada NESTA receita
  custo_unit       numeric NOT NULL DEFAULT 0,  -- snapshot do custo/unid.base da MP
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_materias_primas_empresa ON materias_primas(empresa_id, ativo);
CREATE INDEX IF NOT EXISTS idx_fichas_tecnicas_empresa ON fichas_tecnicas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_ficha_itens_ficha       ON ficha_itens(ficha_id);

ALTER TABLE materias_primas ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichas_tecnicas ENABLE ROW LEVEL SECURITY;
ALTER TABLE ficha_itens     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS materias_primas_empresa_all ON materias_primas;
CREATE POLICY materias_primas_empresa_all ON materias_primas
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS fichas_tecnicas_empresa_all ON fichas_tecnicas;
CREATE POLICY fichas_tecnicas_empresa_all ON fichas_tecnicas
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS ficha_itens_empresa_all ON ficha_itens;
CREATE POLICY ficha_itens_empresa_all ON ficha_itens
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));
