-- POR QUE ESTE CLIENTE PRECISA RECONFIRMAR O ENDERECO (25/10/2026)
--
-- `reconfirmar_endereco` ja existia, mas e um sim/nao: a tela so sabia dizer
-- "arraste o pino". Pra quem tem o BAIRRO divergente isso nao resolve — ele
-- arrasta o pino e continua com o bairro errado no cadastro, que e o que faz o
-- motoboy procurar no lugar errado.
--
-- Na carga de pinos de hoje, 81 clientes vieram assim: a rua e o numero existem
-- e o Google acha, mas o bairro que ele devolve e outro. Pode ser o cliente que
-- escreveu errado, pode ser rua de nome repetido na cidade. Quem sabe e ele.
--
-- Guardando o MOTIVO, a tela consegue falar a lingua do problema: pedir pra
-- digitar a rua de novo e escolher o bairro certo, em vez de um recado generico.
alter table clientes
  add column if not exists reconfirmar_motivo text;

comment on column clientes.reconfirmar_motivo is
  'Por que o endereco precisa ser reconfirmado: "bairro" = o bairro do cadastro nao bate com o que o mapa achou. Nulo = aviso generico.';
