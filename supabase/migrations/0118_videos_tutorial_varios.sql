-- Varios videos por funcionalidade (antes era so 1).
--
-- Motivo: telas grandes como o Gestor de Pedidos precisam de um video por
-- botao/recurso, nao um video unico tentando cobrir tudo. Video curto e
-- direto ao ponto e o que a pessoa realmente assiste ate o fim.
--
-- `chave` deixa de ser chave primaria e passa a ser o GRUPO (a funcionalidade).
-- Cada linha vira um video daquele grupo, ordenado por `ordem`.
--
-- A tabela esta vazia (nenhum video cadastrado ainda), entao a troca da PK
-- e limpa e nao ha o que migrar.

alter table videos_tutorial drop constraint if exists videos_tutorial_pkey;

alter table videos_tutorial
  add column if not exists id uuid not null default gen_random_uuid();

alter table videos_tutorial add primary key (id);

-- Dois videos diferentes nao podem apontar pro mesmo video do YouTube dentro
-- da mesma funcionalidade (evita duplicar sem querer ao colar de novo).
create unique index if not exists videos_tutorial_chave_youtube_uk
  on videos_tutorial (chave, youtube_id);

create index if not exists videos_tutorial_chave_ordem_idx
  on videos_tutorial (chave, ordem);

comment on column videos_tutorial.chave  is 'Funcionalidade (grupo). Casa com data-video nos cards da landing. Repete entre os videos do mesmo grupo.';
comment on column videos_tutorial.titulo is 'Titulo do video (ex: "Como imprimir o cupom"). Aparece na lista dentro do card.';
comment on column videos_tutorial.ordem  is 'Ordem de exibicao dentro da funcionalidade.';
