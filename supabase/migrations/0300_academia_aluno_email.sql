-- =========================================================
-- Migration 0300 - E-mail de contato do aluno
-- =========================================================
-- No Perfil o aluno pode deixar o e-mail dele. É só contato: quem manda no
-- login continua sendo o telefone (o e-mail da conta é interno, mig 0298).
-- =========================================================

alter table academia_alunos add column if not exists email text;

comment on column academia_alunos.email is
  'E-mail de contato do aluno, preenchido por ele no Perfil. Não é o e-mail de login (mig 0300).';
