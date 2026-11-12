-- Series, repeticoes, descanso e METODO em cada exercicio.
--
-- Ate aqui a prescricao era UMA so pro treino inteiro: as 8 semanas diziam
-- "3 series de 12 a 15" e isso valia pra todos os exercicios. O professor nao
-- tinha como escrever o que ele faz na pratica — por exemplo a progressao:
-- "2 series de 16, descanso de 20 segundos, e na sequencia 8 repeticoes com o
-- dobro do peso". Ele montava no papel por causa disso.
--
-- Agora cada exercicio pode ter a prescricao dele. Quem nao tiver continua
-- seguindo o microciclo da semana, que e o caso da maioria.
alter table academia_treino_itens
  add column if not exists series       smallint,
  add column if not exists repeticoes   text,
  add column if not exists descanso_seg smallint,
  add column if not exists metodo       text;

comment on column academia_treino_itens.series is
  'Series SO deste exercicio. Vazio = segue as 8 semanas do aluno.';
comment on column academia_treino_itens.repeticoes is
  'Repeticoes como o professor escreve: "16", "8 a 12", "16 + 8 pesado". Vazio = segue as 8 semanas.';
comment on column academia_treino_itens.descanso_seg is
  'Descanso entre as series, em segundos. O cronometro do app do aluno usa este numero.';
comment on column academia_treino_itens.metodo is
  'Metodo do exercicio em uma linha: progressao, bi-set, drop-set, piramide... Aparece em destaque pro aluno.';
