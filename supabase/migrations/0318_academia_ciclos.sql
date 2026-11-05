-- Em que pe esta o ciclo de cada aluno, numa linha so por aluno.
--
-- A tela do professor precisa marcar na lista quem ja terminou as 8 semanas
-- (com 460 alunos ninguem abre um por um pra descobrir). Ler academia_semanas
-- direto do site nao serve: sao ate 8 linhas por aluno, o que estoura o limite
-- de 1000 linhas do PostgREST com menos de 130 alunos.
create or replace function public.academia_ciclos()
returns table (aluno_id uuid, semanas int, inicio date, exercicios int)
language sql
stable
security invoker
set search_path to 'public'
as $$
  select a.id,
         (select count(*)::int from academia_semanas s
           where s.aluno_id = a.id and (s.series is not null or s.rep_min is not null)),
         a.microciclo_inicio,
         (select count(*)::int from academia_treino_itens i
            join academia_treinos t on t.id = i.treino_id
           where t.aluno_id = a.id)
  from academia_alunos a
  where a.empresa_id = (select current_empresa_id())
    and a.ativo;
$$;

comment on function public.academia_ciclos is
  'Uma linha por aluno ativo da empresa: quantas semanas do microciclo estao montadas, quando o ciclo comecou e quantos exercicios ele tem. Para a lista do professor.';
