-- =========================================================
-- Migration 0296 - Academia: login do aluno
-- =========================================================
-- O aluno entra no MESMO endereço da academia e só vê a parte dele (treino,
-- mensalidade, frequência, rosto) — como o garçom só vê o salão.
--
-- A conta dele é um usuário normal do sistema com perfil 'aluno', apelido =
-- matrícula e e-mail interno <matricula>@aluno.fwcinter.com (o aluno nunca
-- digita esse e-mail: entra pela matrícula).
-- =========================================================

alter table academia_alunos add column if not exists profile_id uuid references profiles(id) on delete set null;

create index if not exists academia_alunos_profile_idx on academia_alunos (profile_id);

comment on column academia_alunos.profile_id is
  'Conta de login do aluno (profiles.perfil = ''aluno''), criada na importação; o aluno entra pela matrícula (mig 0296).';

-- O aluno lê e atualiza a ficha dele (rosto, telefone), nada de outro aluno.
drop policy if exists "academia_alunos aluno le a dele" on academia_alunos;
create policy "academia_alunos aluno le a dele" on academia_alunos
  for select to authenticated using (profile_id = auth.uid());

drop policy if exists "academia_alunos aluno altera a dele" on academia_alunos;
create policy "academia_alunos aluno altera a dele" on academia_alunos
  for update to authenticated using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Entradas e pagamentos: o aluno vê os dele.
drop policy if exists "academia_acessos aluno ve os dele" on academia_acessos;
create policy "academia_acessos aluno ve os dele" on academia_acessos
  for select to authenticated using (
    aluno_id in (select id from academia_alunos where profile_id = auth.uid())
  );

drop policy if exists "academia_pagamentos aluno ve os dele" on academia_pagamentos;
create policy "academia_pagamentos aluno ve os dele" on academia_pagamentos
  for select to authenticated using (
    aluno_id in (select id from academia_alunos where profile_id = auth.uid())
  );
