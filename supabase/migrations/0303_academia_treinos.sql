-- =========================================================
-- Migration 0303 - Treinos (o cartão do professor, no sistema)
-- =========================================================
-- O professor da Vieira Raça monta assim, no papel:
--   • uma lista de exercícios por grupo, cada um com o NÚMERO DA MÁQUINA
--     pintado no aparelho (Agachamento 01, Leg 45° 06, Supino Reto 20...);
--     peso livre ele marca "0";
--   • treinos A, B, C, D e E, cada um num dia da semana, circulando os
--     exercícios escolhidos e anotando a variação (H = halteres, UNI, ABERTO);
--   • um microciclo de 8 semanas onde muda série e repetição
--     (ex.: 3x 8-12 → 3x 12-15 → 4x 8-12 → 4x 6-10 ...).
-- É isso, igual, que entra aqui.
-- =========================================================

-- Perfil do professor (entra pelo celular, como o aluno).
alter table profiles drop constraint if exists profiles_perfil_check;
alter table profiles add constraint profiles_perfil_check
  check (perfil = any (array[
    'admin', 'vendedor', 'garcom', 'cozinheiro', 'entregador', 'cliente', 'super_admin', 'aluno', 'professor'
  ]));

-- ── Catálogo de exercícios da academia ────────────────────────────────────
create table if not exists academia_exercicios (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  grupo      text not null,
  nome       text not null,
  maquina    text,
  ordem      integer not null default 0,
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);

create index if not exists academia_exercicios_empresa_idx on academia_exercicios (empresa_id, grupo, ordem);

alter table academia_exercicios enable row level security;

drop policy if exists "academia_exercicios equipe" on academia_exercicios;
create policy "academia_exercicios equipe" on academia_exercicios
  for all to authenticated using (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());

-- O aluno precisa ler o nome e a máquina do exercício do treino dele.
drop policy if exists "academia_exercicios aluno le" on academia_exercicios;
create policy "academia_exercicios aluno le" on academia_exercicios
  for select to authenticated using (
    empresa_id in (select empresa_id from academia_alunos where profile_id = auth.uid())
  );

comment on table academia_exercicios is
  'Exercícios que a academia tem, com o número da máquina pintado no aparelho (mig 0303).';

-- ── Treino do aluno (A, B, C, D, E) ───────────────────────────────────────
create table if not exists academia_treinos (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  aluno_id    uuid not null references academia_alunos(id) on delete cascade,
  letra       text not null,
  dia_semana  text,
  nome        text,
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now(),
  criado_por  uuid references auth.users(id) on delete set null
);

create index if not exists academia_treinos_aluno_idx on academia_treinos (aluno_id, letra);

create table if not exists academia_treino_itens (
  id           uuid primary key default gen_random_uuid(),
  treino_id    uuid not null references academia_treinos(id) on delete cascade,
  exercicio_id uuid references academia_exercicios(id) on delete set null,
  nome         text not null,
  maquina      text,
  variacao     text,
  ordem        integer not null default 0,
  observacao   text
);

create index if not exists academia_treino_itens_idx on academia_treino_itens (treino_id, ordem);

-- ── Microciclo: o que muda a cada semana ─────────────────────────────────
create table if not exists academia_semanas (
  id         uuid primary key default gen_random_uuid(),
  aluno_id   uuid not null references academia_alunos(id) on delete cascade,
  numero     integer not null,
  series     integer,
  rep_min    integer,
  rep_max    integer,
  sistema    text,
  aumentar_peso boolean not null default false,
  unique (aluno_id, numero)
);

comment on table academia_semanas is
  'Microciclo do aluno: série e repetição de cada semana (3x 8-12, 4x 6-10...), sistema (série única, bissérie) e quando aumenta o peso (mig 0303).';

alter table academia_treinos enable row level security;
alter table academia_treino_itens enable row level security;
alter table academia_semanas enable row level security;

drop policy if exists "academia_treinos equipe" on academia_treinos;
create policy "academia_treinos equipe" on academia_treinos
  for all to authenticated using (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());

drop policy if exists "academia_treinos aluno le" on academia_treinos;
create policy "academia_treinos aluno le" on academia_treinos
  for select to authenticated using (
    aluno_id in (select id from academia_alunos where profile_id = auth.uid())
  );

drop policy if exists "academia_treino_itens equipe" on academia_treino_itens;
create policy "academia_treino_itens equipe" on academia_treino_itens
  for all to authenticated using (
    treino_id in (select id from academia_treinos where empresa_id = current_empresa_id())
  ) with check (
    treino_id in (select id from academia_treinos where empresa_id = current_empresa_id())
  );

drop policy if exists "academia_treino_itens aluno le" on academia_treino_itens;
create policy "academia_treino_itens aluno le" on academia_treino_itens
  for select to authenticated using (
    treino_id in (
      select t.id from academia_treinos t
      join academia_alunos a on a.id = t.aluno_id
      where a.profile_id = auth.uid()
    )
  );

drop policy if exists "academia_semanas equipe" on academia_semanas;
create policy "academia_semanas equipe" on academia_semanas
  for all to authenticated using (
    aluno_id in (select id from academia_alunos where empresa_id = current_empresa_id())
  ) with check (
    aluno_id in (select id from academia_alunos where empresa_id = current_empresa_id())
  );

drop policy if exists "academia_semanas aluno le" on academia_semanas;
create policy "academia_semanas aluno le" on academia_semanas
  for select to authenticated using (
    aluno_id in (select id from academia_alunos where profile_id = auth.uid())
  );
