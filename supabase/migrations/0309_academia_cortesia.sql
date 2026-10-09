-- Aluno cortesia: treina de graça (dono, família, funcionário, parceria).
--
-- Até agora a academia resolvia isso botando um vencimento absurdo — 2030,
-- 2040 — só pra nunca vencer. Funcionava, mas a tela dizia "Em dia até
-- 08/11/2040", e ninguém sabia quantas cortesias a academia tinha. Cada uma
-- é uma vaga ocupada que não gera receita, então é número de negócio.
alter table academia_alunos
  add column if not exists cortesia boolean not null default false;

-- Quem já estava com a data de mentira vira cortesia de verdade, e perde o
-- vencimento: cortesia não vence.
update academia_alunos
set cortesia = true, vencimento = null
where vencimento is not null
  and vencimento > (current_date + interval '3 years');

create index if not exists academia_alunos_cortesia_idx
  on academia_alunos (empresa_id) where cortesia;
