-- Videos tutoriais das funcionalidades (YouTube).
--
-- Ficam ligados aos cards da landing (fwcinter.com) pela `chave`, que e a mesma
-- do atributo data-video no landing.html. Card sem video cadastrado (ou com
-- ativo=false) continua sendo um card comum, sem botao de play — assim da pra
-- publicar um video de cada vez, conforme grava, sem precisar ter todos prontos.
--
-- Por que YouTube e nao arquivo no storage: banda de video e o que mais custa,
-- e o custo cresceria junto com o sucesso do site. No YouTube (nao listado) o
-- custo e zero em qualquer volume, e ele ajusta a qualidade sozinho — importante
-- porque a maioria vai assistir pelo celular, no 4G.

create table if not exists videos_tutorial (
  chave       text primary key,
  titulo      text not null,
  descricao   text,
  youtube_id  text not null,
  ativo       boolean not null default true,
  ordem       integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table  videos_tutorial is 'Videos tutoriais por funcionalidade. `chave` casa com data-video nos cards da landing.';
comment on column videos_tutorial.youtube_id is 'So o ID do video do YouTube (ex: dQw4w9WgXcQ), nao a URL inteira.';

drop trigger if exists trg_videos_tutorial_updated_at on videos_tutorial;
create trigger trg_videos_tutorial_updated_at
  before update on videos_tutorial
  for each row execute function set_updated_at();

alter table videos_tutorial enable row level security;

-- A landing e publica e nao tem login: qualquer visitante precisa ler.
drop policy if exists "Qualquer um ve videos ativos" on videos_tutorial;
create policy "Qualquer um ve videos ativos"
  on videos_tutorial for select
  using (ativo = true);

-- So o dono da plataforma cadastra/edita.
drop policy if exists "Super admin gerencia videos" on videos_tutorial;
create policy "Super admin gerencia videos"
  on videos_tutorial for all
  using (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');
