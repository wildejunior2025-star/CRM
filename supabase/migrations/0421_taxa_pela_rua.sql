-- Taxa por km medida PELA RUA (Google Routes, de moto) em vez da linha reta.
--
-- Chave por loja, desligada por padrao: as faixas de km de cada loja foram
-- montadas em cima da linha reta, e pela rua da em media 1,3x a 1,5x (medido
-- em 47 entregas reais em 28/10/2026). Ligar sem rever as faixas sobe a taxa.
--
-- A conferencia do banco (taxa_entrega_esperada) continua em linha reta e so
-- recusa taxa MENOR que a dela; pela rua a taxa e sempre igual ou maior, entao
-- os dois convivem sem travar pedido.
alter table public.empresas add column if not exists taxa_pela_rua boolean not null default false;

-- Teste: so a loja de demonstracao.
update public.empresas set taxa_pela_rua = true where id = 'e12b4527-5189-4fcc-9f4b-0d57c8ff29a9';
