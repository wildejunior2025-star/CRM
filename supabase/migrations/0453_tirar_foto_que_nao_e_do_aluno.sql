-- Tira do cadastro a foto que nao e a cara do aluno.
--
-- 13/11/2026 a catraca mostrou "eduardo" com outra pessoa na frente da
-- camera. Olhando as 4 fotos do cadastro dele, tres combinam entre si
-- (0,14 a 0,21 de distancia) e a PRIMEIRA esta a 0,74 das outras — ou seja,
-- nao e ele. Uma foto errada no cadastro e um ima: leitura ruim de qualquer
-- pessoa pode cair perto dela, e a catraca abre no nome de quem nao esta la.
--
-- Criterio: a foto que esta a mais de 0,5 de TODAS as outras do mesmo aluno
-- nao e do mesmo rosto (o proprio modelo usa 0,6 como "pessoa diferente", e
-- as fotos boas do mesmo aluno ficam entre 0,10 e 0,25 aqui). Sai do cadastro
-- e fica guardada, pra dar pra voltar se algum dia fizer falta.
--
-- Deu 12 fotos em 11 alunos; todos ficaram com 2 ou 3 fotos boas.

create table if not exists academia_descritores_lixo (
  id        uuid primary key default gen_random_uuid(),
  aluno_id  uuid not null references academia_alunos(id) on delete cascade,
  amostra   int,
  descritor jsonb,
  motivo    text,
  criado_em timestamptz not null default now()
);
alter table academia_descritores_lixo enable row level security;
-- Sem policy de proposito: isto e so o backup, nenhuma tela le.

with d as (
  select a.id, t.ord as amostra, e.ord as pos, e.v::numeric as v
  from academia_alunos a
  cross join lateral jsonb_array_elements(a.descritores) with ordinality t(arr, ord)
  cross join lateral jsonb_array_elements_text(t.arr) with ordinality e(v, ord)
  where jsonb_array_length(coalesce(a.descritores,'[]'::jsonb)) > 1
),
soma as (
  select x.id, x.amostra, y.amostra as outra, sum((x.v - y.v)^2) as sq
  from d x join d y on y.id = x.id and y.pos = x.pos and y.amostra <> x.amostra
  group by 1,2,3
),
par as (select id, amostra, min(sqrt(sq)) as mais_perto from soma group by 1,2),
ruim as (select id, amostra from par where mais_perto > 0.5)
insert into academia_descritores_lixo (aluno_id, amostra, descritor, motivo)
select r.id, r.amostra, a.descritores -> (r.amostra - 1)::int,
       'longe de todas as outras fotos do mesmo aluno (nao e o mesmo rosto)'
from ruim r join academia_alunos a on a.id = r.id;

update academia_alunos a
set descritores = coalesce((
  select jsonb_agg(t.arr order by t.ord)
  from jsonb_array_elements(a.descritores) with ordinality t(arr, ord)
  where not exists (
    select 1 from academia_descritores_lixo l
    where l.aluno_id = a.id and l.amostra = t.ord
  )
), '[]'::jsonb)
where exists (select 1 from academia_descritores_lixo l where l.aluno_id = a.id);
