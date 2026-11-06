-- A lista do professor tambem precisa dizer QUEM CONSEGUE ENTRAR NO APP.
--
-- Montar treino pra quem nao entra no app e trabalho que nao chega no aluno.
-- Entrar depende de duas coisas: ter conta (profile_id) e ter TELEFONE no
-- cadastro, porque o aluno entra digitando o telefone e os 4 ultimos numeros
-- dele. Hoje 238 dos 462 ativos estao sem telefone — vieram assim do SCA.
--
-- Com a marca na lista, o professor ja avisa na hora: "passa na recepcao pra
-- botar seu numero", em vez de descobrir depois que ninguem viu o treino.
drop function if exists public.academia_ciclos();

create function public.academia_ciclos()
returns table (
  aluno_id    uuid,
  semanas     int,
  inicio      date,
  exercicios  int,
  entra_app   boolean,
  falta       text
)
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
           where t.aluno_id = a.id),
         (a.profile_id is not null
            and length(regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g')) >= 4),
         case
           when length(regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g')) < 4 then 'telefone'
           when a.profile_id is null then 'conta'
           else null
         end
  from academia_alunos a
  where a.empresa_id = (select current_empresa_id())
    and a.ativo;
$$;

comment on function public.academia_ciclos is
  'Uma linha por aluno ativo da empresa: semanas do microciclo montadas, inicio do ciclo, exercicios, se ele consegue entrar no app e o que falta (telefone ou conta). Para a lista do professor.';
