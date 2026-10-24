-- O EMISSOR NAO ACHA A LOJA PELO CNPJ (24/10/2026)
--
-- A gente consultava o Focus em /v2/empresas/{cnpj} e levava 404 "Empresa nao
-- encontrada" — mesmo com a loja cadastrada e com os tokens prontos. A API
-- daquele lado so aceita o id interno dela. Resultado: registrava direitinho e
-- depois nao conseguia emitir, com uma mensagem que mandava registrar de novo.
--
-- Agora guardamos o id que o emissor devolve.
alter table empresa_fiscal
  add column if not exists emissor_empresa_id text;

comment on column empresa_fiscal.emissor_empresa_id is
  'Id da loja DENTRO do emissor (Focus). E por ele que se consulta — o CNPJ da 404.';
