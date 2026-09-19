-- =========================================================
-- Migration 0276 - Academia: alunos com rosto + entradas
-- =========================================================
-- Primeira academia cliente (19/09/2026). Começo barato: um tablet na
-- recepção (academia.fwcinter.com/recepcao) reconhece o rosto, mostra se a
-- mensalidade está em dia e anota a entrada. A catraca ainda abre no botão
-- manual; depois entra um relé.
--
-- academia_alunos   → cadastro do aluno. `descritores` são as "digitais do
--                     rosto" (vetores de 128 números, uma por foto tirada no
--                     cadastro). `foto` é uma miniatura pra recepção conferir.
-- academia_acessos  → cada vez que o tablet reconheceu alguém.
--
-- Rosto é dado biométrico (LGPD): tudo fica preso à empresa pela RLS, sem
-- leitura pública, e o cadastro guarda o aceite do aluno.
-- =========================================================

create table if not exists academia_alunos (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references empresas(id) on delete cascade,
  nome         text not null,
  telefone     text,
  plano        text,
  valor        numeric(10,2),
  vencimento   date,
  foto         text,
  descritores  jsonb not null default '[]'::jsonb,
  consentimento_em timestamptz,
  ativo        boolean not null default true,
  criado_em    timestamptz not null default now()
);

create index if not exists academia_alunos_empresa_idx on academia_alunos (empresa_id, ativo);

alter table academia_alunos enable row level security;

drop policy if exists "academia_alunos loja le" on academia_alunos;
create policy "academia_alunos loja le" on academia_alunos
  for select to authenticated using (empresa_id = current_empresa_id());

drop policy if exists "academia_alunos loja grava" on academia_alunos;
create policy "academia_alunos loja grava" on academia_alunos
  for insert to authenticated with check (empresa_id = current_empresa_id());

drop policy if exists "academia_alunos loja altera" on academia_alunos;
create policy "academia_alunos loja altera" on academia_alunos
  for update to authenticated using (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());

drop policy if exists "academia_alunos loja apaga" on academia_alunos;
create policy "academia_alunos loja apaga" on academia_alunos
  for delete to authenticated using (empresa_id = current_empresa_id());

comment on table academia_alunos is
  'Alunos da academia com as digitais do rosto (descritores face-api, 128 números cada) para a recepção reconhecer (mig 0276).';

create table if not exists academia_acessos (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  aluno_id    uuid not null references academia_alunos(id) on delete cascade,
  resultado   text not null check (resultado in ('liberado', 'vencido', 'inativo')),
  distancia   numeric(5,3),
  criado_em   timestamptz not null default now()
);

create index if not exists academia_acessos_empresa_idx on academia_acessos (empresa_id, criado_em desc);
create index if not exists academia_acessos_aluno_idx on academia_acessos (aluno_id, criado_em desc);

alter table academia_acessos enable row level security;

drop policy if exists "academia_acessos loja le" on academia_acessos;
create policy "academia_acessos loja le" on academia_acessos
  for select to authenticated using (empresa_id = current_empresa_id());

drop policy if exists "academia_acessos loja grava" on academia_acessos;
create policy "academia_acessos loja grava" on academia_acessos
  for insert to authenticated with check (empresa_id = current_empresa_id());

comment on table academia_acessos is
  'Entradas reconhecidas pelo tablet da recepção da academia (mig 0276).';
