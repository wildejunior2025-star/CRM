-- CSC NAO E UM SO: E UM POR AMBIENTE (24/10/2026)
--
-- A tabela guardava um `csc` unico, aplicado a qualquer ambiente. So que a
-- SEFAZ emite codigos diferentes pra homologacao e pra producao — a Agv tem os
-- quatro lado a lado no portal. Com uma coluna so, o dia de virar a chave pra
-- producao ia mandar o codigo de homologacao, e TODA nota seria rejeitada justo
-- na estreia.
--
-- Agora cada ambiente guarda o seu, e o emissor escolhe na hora.
alter table empresa_fiscal
  add column if not exists csc_homologacao text,
  add column if not exists csc_id_homologacao text,
  add column if not exists csc_producao text,
  add column if not exists csc_id_producao text;

-- Leva o que ja existia pro ambiente em que a loja esta hoje.
update empresa_fiscal
   set csc_homologacao    = coalesce(csc_homologacao, csc),
       csc_id_homologacao = coalesce(csc_id_homologacao, csc_id)
 where csc is not null and ambiente <> 'producao';

update empresa_fiscal
   set csc_producao    = coalesce(csc_producao, csc),
       csc_id_producao = coalesce(csc_id_producao, csc_id)
 where csc is not null and ambiente = 'producao';

comment on column empresa_fiscal.csc_producao is 'CSC do ambiente de producao (SEFAZ). Nunca e igual ao de homologacao.';
comment on column empresa_fiscal.csc_homologacao is 'CSC do ambiente de homologacao. Na SEFAZ-RN vale 90 dias e precisa ser regerado.';
