-- =========================================================
-- Migration 0305 - Carga, treino feito e vídeo do exercício
-- =========================================================
-- Olhando os apps concorrentes (Tecnofit, Pacto Treino, Pro-Treino), o que o
-- nosso não tinha e todo mundo tem:
--   • o aluno ANOTAR A CARGA de cada exercício e ver a da última vez;
--   • marcar o treino como FEITO (o app conta quantos ele fez no mês);
--   • VÍDEO/foto de execução no exercício.
-- É isso que entra aqui.
-- =========================================================

alter table academia_exercicios add column if not exists video_url text;

comment on column academia_exercicios.video_url is
  'Link de vídeo mostrando a execução (YouTube etc.), que o aluno abre no app (mig 0305).';

create table if not exists academia_execucoes (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  aluno_id    uuid not null references academia_alunos(id) on delete cascade,
  treino_id   uuid references academia_treinos(id) on delete cascade,
  item_id     uuid references academia_treino_itens(id) on delete cascade,
  data        date not null default current_date,
  carga       numeric(6,2),
  feito       boolean not null default true,
  criado_em   timestamptz not null default now()
);

create index if not exists academia_execucoes_aluno_idx on academia_execucoes (aluno_id, data desc);
create index if not exists academia_execucoes_item_idx on academia_execucoes (item_id, data desc);

alter table academia_execucoes enable row level security;

-- O aluno registra e lê o que é dele.
drop policy if exists "academia_execucoes aluno" on academia_execucoes;
create policy "academia_execucoes aluno" on academia_execucoes
  for all to authenticated using (
    aluno_id in (select id from academia_alunos where profile_id = auth.uid())
  ) with check (
    aluno_id in (select id from academia_alunos where profile_id = auth.uid())
  );

-- A academia (dono e professor) acompanha.
drop policy if exists "academia_execucoes equipe" on academia_execucoes;
create policy "academia_execucoes equipe" on academia_execucoes
  for select to authenticated using (empresa_id = current_empresa_id());

comment on table academia_execucoes is
  'Cada exercício que o aluno marcou como feito, com a carga que usou. É daqui que sai o "última vez: 20 kg" (mig 0305).';
