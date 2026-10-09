-- Procurar "fabio" tem que achar "Fábio". Num cadastro brasileiro, busca que
-- exige acento certo faz a recepção jurar que o aluno não existe.
create extension if not exists unaccent;

-- unaccent() do Postgres não é IMMUTABLE (depende do dicionário carregado), e
-- coluna gerada só aceita função immutable. Fixando o dicionário, vira.
create or replace function public.sem_acento(t text)
returns text language sql immutable strict parallel safe as
$$ select unaccent('public.unaccent', lower(coalesce(t, ''))) $$;

alter table academia_alunos
  add column if not exists nome_busca text
  generated always as (public.sem_acento(nome)) stored;
