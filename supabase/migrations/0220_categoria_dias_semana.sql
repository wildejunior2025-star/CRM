-- =========================================================
-- 0220: categoria que só aparece em certos dias da semana
-- =========================================================
-- A categoria já sabia a HORA (mig 0096: almoço das 11h às 14h). Faltava o DIA.
-- A CD Bom tem a "Quarta do Picolé": promoção que vale só na quarta-feira, e nos
-- outros dias alguém tinha que lembrar de pausar item por item na mão — e
-- lembrar de despausar de novo na quarta seguinte.
--
-- Vazio (ou nulo) = todo dia, que é como as categorias de hoje se comportam.
-- Os números seguem o padrão do JavaScript e do Postgres: 0=domingo ... 6=sábado.
-- =========================================================

ALTER TABLE categorias ADD COLUMN IF NOT EXISTS dias_semana smallint[];

ALTER TABLE categorias DROP CONSTRAINT IF EXISTS categorias_dias_semana_validos;
ALTER TABLE categorias ADD CONSTRAINT categorias_dias_semana_validos
  CHECK (dias_semana IS NULL OR dias_semana <@ ARRAY[0,1,2,3,4,5,6]::smallint[]);

COMMENT ON COLUMN categorias.dias_semana IS
  'Dias em que a categoria aparece na vitrine (0=domingo..6=sabado). Nulo ou vazio = todo dia.';
