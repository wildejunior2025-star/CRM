-- =========================================================
-- Migration 0302 - Ficha do aluno (verso do cartão de papel)
-- =========================================================
-- O cartão da Vieira Raça tem, atrás: idade, sexo, marcações de saúde
-- (diabetes, hipertensão, cardiopata, outra) e a avaliação física com as
-- medidas. É isso que entra aqui.
--
-- As medidas viram HISTÓRICO: no papel o professor só via a última; aqui ele
-- compara com a anterior e mostra a evolução pro aluno.
-- =========================================================

alter table academia_alunos add column if not exists nascimento date;
alter table academia_alunos add column if not exists sexo text check (sexo in ('M', 'F') or sexo is null);
alter table academia_alunos add column if not exists diabetes boolean not null default false;
alter table academia_alunos add column if not exists hipertensao boolean not null default false;
alter table academia_alunos add column if not exists cardiopata boolean not null default false;
alter table academia_alunos add column if not exists saude_outra text;
alter table academia_alunos add column if not exists objetivo text;

comment on column academia_alunos.saude_outra is
  'Campo "Outra" das marcações de saúde do cartão (mig 0302).';

create table if not exists academia_avaliacoes (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references empresas(id) on delete cascade,
  aluno_id        uuid not null references academia_alunos(id) on delete cascade,
  data            date not null default current_date,
  peso            numeric(6,2),
  estatura        numeric(5,2),
  peitoral        numeric(6,2),
  ombro           numeric(6,2),
  cintura         numeric(6,2),
  quadril         numeric(6,2),
  braco_dir       numeric(6,2),
  braco_esq       numeric(6,2),
  antebraco_dir   numeric(6,2),
  antebraco_esq   numeric(6,2),
  coxa_dir        numeric(6,2),
  coxa_esq        numeric(6,2),
  panturrilha_dir numeric(6,2),
  panturrilha_esq numeric(6,2),
  observacao      text,
  criado_em       timestamptz not null default now(),
  criado_por      uuid references auth.users(id) on delete set null
);

create index if not exists academia_avaliacoes_aluno_idx on academia_avaliacoes (aluno_id, data desc);

alter table academia_avaliacoes enable row level security;

drop policy if exists "academia_avaliacoes loja le" on academia_avaliacoes;
create policy "academia_avaliacoes loja le" on academia_avaliacoes
  for select to authenticated using (empresa_id = current_empresa_id());

drop policy if exists "academia_avaliacoes loja grava" on academia_avaliacoes;
create policy "academia_avaliacoes loja grava" on academia_avaliacoes
  for insert to authenticated with check (empresa_id = current_empresa_id());

drop policy if exists "academia_avaliacoes loja altera" on academia_avaliacoes;
create policy "academia_avaliacoes loja altera" on academia_avaliacoes
  for update to authenticated using (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());

drop policy if exists "academia_avaliacoes loja apaga" on academia_avaliacoes;
create policy "academia_avaliacoes loja apaga" on academia_avaliacoes
  for delete to authenticated using (empresa_id = current_empresa_id());

-- O aluno vê as avaliações dele (a evolução aparece no app).
drop policy if exists "academia_avaliacoes aluno ve as dele" on academia_avaliacoes;
create policy "academia_avaliacoes aluno ve as dele" on academia_avaliacoes
  for select to authenticated using (
    aluno_id in (select id from academia_alunos where profile_id = auth.uid())
  );

comment on table academia_avaliacoes is
  'Avaliação física do aluno (medidas do verso do cartão). Cada medição é uma linha, pra comparar com a anterior (mig 0302).';
