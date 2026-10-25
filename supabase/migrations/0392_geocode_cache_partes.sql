-- 0392 — O cache do Google guarda tambem o endereco separado.
--
-- Teste no Chrome em 25/10/2026: escolhendo "Av. Nascimento de Castro, 81" na
-- lista, a tela mostrava a conferencia certinha (casa exata, foto do mapa) mas
-- deixava bairro, cidade e CEP VAZIOS. Motivo: aquele endereco ja estava no
-- cache de 30 dias, e o cache so guardava o PONTO.
--
-- Ou seja, falhava justamente no caso mais comum: o cliente que ja comprou
-- antes. A primeira venda preenchia tudo; a segunda, nao.
alter table geocode_cache add column if not exists partes jsonb;

comment on column geocode_cache.partes is
  'Endereco separado (rua, numero, bairro, cidade, estado, cep) pra tela preencher sozinha tambem quando vier do cache.';
