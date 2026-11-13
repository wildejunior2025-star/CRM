-- Pra saber onde a catraca esta lenta sem precisar olhar a tela da academia.
--
-- Ate aqui o acesso guardava so a distancia. Nao dava pra responder a
-- pergunta do dono — "por que o aluno precisa parar?" — sem ir ate la: o
-- tempo de cada leitura e o aparelho usado so apareciam no cantinho da tela.
alter table academia_acessos
  add column if not exists margem    numeric,
  add column if not exists ms        integer,
  add column if not exists leituras  smallint,
  add column if not exists motor     text;

comment on column academia_acessos.margem is
  'Distancia do segundo colocado menos a do reconhecido. Quanto maior, mais certa a leitura.';
comment on column academia_acessos.ms is
  'Media de milissegundos por leitura completa neste aparelho na hora do acesso.';
comment on column academia_acessos.leituras is
  'Quantas leituras seguidas foram exigidas antes de liberar (1 = reconheceu de primeira).';
comment on column academia_acessos.motor is
  'webgl (placa de video) ou cpu, mais o tamanho do detector. CPU e ~10x mais lento.';
