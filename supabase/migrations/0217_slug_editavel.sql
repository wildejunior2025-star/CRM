-- =========================================================
-- Migration 0217 — Link da loja editável, sem quebrar o antigo
-- =========================================================
-- O dono trocava o nome da loja e o link continuava o velho (a "deposito da
-- gaby" virou "deposito de Thiago" e o link seguiu /deposito-da-gaby). Agora ele
-- edita o link — mas o link antigo NÃO pode morrer: ele já foi mandado no
-- WhatsApp, impresso, anunciado. Guardamos os anteriores aqui e a vitrine
-- aceita todos, sempre abrindo a loja certa.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS slugs_antigos text[] NOT NULL DEFAULT '{}';

-- Busca por link antigo (`slugs_antigos @> {slug}`) sem varrer a tabela.
CREATE INDEX IF NOT EXISTS empresas_slugs_antigos_idx ON empresas USING gin (slugs_antigos);

COMMENT ON COLUMN empresas.slugs_antigos IS
  'Links que a loja já teve. A vitrine pública resolve por eles também, pra link velho nunca dar 404.';
