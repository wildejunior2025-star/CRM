-- Quem realmente usa o app do aluno. Sem isso, cobrar pelo app depois seria
-- chute: o dono pergunta "mas alguém usa?" e não há resposta. Um registro
-- por aluno por DIA — dá pra contar ativos na semana e no mês, e não cresce
-- (330 alunos x 30 dias = 10 mil linhas por mês).
create table if not exists academia_app_uso (
  aluno_id uuid not null references academia_alunos(id) on delete cascade,
  dia date not null,
  aberturas integer not null default 1,
  primary key (aluno_id, dia)
);

alter table academia_alunos
  add column if not exists app_visto_em timestamptz;

alter table academia_app_uso enable row level security;

-- A academia enxerga o uso dos próprios alunos.
drop policy if exists academia_app_uso_le on academia_app_uso;
create policy academia_app_uso_le on academia_app_uso for select
using (exists (
  select 1 from academia_alunos a
  join profiles p on p.empresa_id = a.empresa_id
  where a.id = academia_app_uso.aluno_id
    and p.id = auth.uid()
    and p.perfil in ('admin', 'super_admin', 'professor')
));

-- O aluno não escreve direto: marca por aqui, e a função só deixa ele
-- marcar a si mesmo.
create or replace function academia_marcar_uso()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_aluno uuid;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select id into v_aluno from academia_alunos where profile_id = auth.uid();
  if v_aluno is null then return; end if;

  insert into academia_app_uso (aluno_id, dia) values (v_aluno, v_hoje)
  on conflict (aluno_id, dia)
    do update set aberturas = academia_app_uso.aberturas + 1;

  update academia_alunos set app_visto_em = now() where id = v_aluno;
end $$;

grant execute on function academia_marcar_uso() to authenticated;
