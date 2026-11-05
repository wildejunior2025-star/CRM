-- Modelos de treino da academia.
--
-- Um professor, 460 alunos: montar exercicio por exercicio pra cada um nao
-- acontece. Ele monta tres ou quatro treinos bons (iniciante, emagrecimento,
-- hipertrofia) e aplica em um toque, ajustando o que for diferente.
--
-- O modelo guarda o plano INTEIRO num jsonb com o mesmo formato que o
-- rascunho da IA ja devolve ({ treinos: [{ letra, dia_semana, foco, itens }],
-- semanas: [...] }) — assim a mesma tela de conferir e o mesmo "Usar este
-- treino" servem pros dois, sem caminho novo pra dar manutencao.
create table if not exists academia_modelos (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  nome       text not null,
  observacao text,
  plano      jsonb not null,
  criado_por uuid,
  criado_em  timestamptz not null default now()
);

create index if not exists academia_modelos_empresa on academia_modelos (empresa_id, nome);

alter table academia_modelos enable row level security;

drop policy if exists "academia_modelos equipe" on academia_modelos;
create policy "academia_modelos equipe" on academia_modelos
  for all
  using (empresa_id = (select current_empresa_id()))
  with check (empresa_id = (select current_empresa_id()));
