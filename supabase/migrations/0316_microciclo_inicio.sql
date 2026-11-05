-- Em que dia o ciclo de 8 semanas do aluno comecou.
--
-- Sem isso o app do aluno mostrava SEMPRE a semana 1: o professor montava as 8
-- semanas (3x12-15 na 1, 4x8-12 na 7...) e o aluno nunca saia da primeira, ou
-- seja, a progressao de carga — o motivo de existir o microciclo — nao
-- acontecia. Com a data de inicio, a semana atual e uma conta: quantos
-- domingos passaram desde aqui.
alter table academia_alunos
  add column if not exists microciclo_inicio date;

comment on column academia_alunos.microciclo_inicio is
  'Dia em que o ciclo de 8 semanas comecou. A semana atual = (hoje - este dia) / 7 + 1, travada na ultima semana montada.';

-- Quem ja tem treino montado comeca a contar do dia em que o treino foi criado,
-- senao o ciclo deles nasceria na semana 1 de novo.
update academia_alunos a
set microciclo_inicio = inicio.dia
from (
  select aluno_id, min(criado_em)::date as dia
  from academia_treinos
  group by aluno_id
) inicio
where inicio.aluno_id = a.id
  and a.microciclo_inicio is null;
