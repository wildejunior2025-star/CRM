-- Qualquer usuário autenticado pode ver empresas ativas no portal (marketplace)
DROP POLICY "Cliente ve empresas ativas" ON empresas;

CREATE POLICY "Qualquer autenticado ve empresas ativas"
  ON empresas FOR SELECT
  USING (status IN ('trial', 'ativo', 'atrasado'));
