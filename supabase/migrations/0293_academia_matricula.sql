-- =========================================================
-- Migration 0293 - Academia: matrícula do aluno
-- =========================================================
-- A Vieira Raça fechou em 07/10/2026 e os alunos vêm do sistema antigo (SCA),
-- onde cada um tem uma MATRÍCULA que a academia usa no dia a dia ("o 03025").
-- Ela também é a chave da importação: reimportar não duplica ninguém.
-- =========================================================

alter table academia_alunos add column if not exists matricula text;

create unique index if not exists academia_alunos_matricula_idx
  on academia_alunos (empresa_id, matricula)
  where matricula is not null;

comment on column academia_alunos.matricula is
  'Matrícula do aluno no sistema antigo da academia; única por empresa e usada pra não duplicar na importação (mig 0293).';
