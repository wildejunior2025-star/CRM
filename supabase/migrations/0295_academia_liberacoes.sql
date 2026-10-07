-- =========================================================
-- Migration 0295 - Academia: aberturas manuais da catraca
-- =========================================================
-- Botão "Abrir catraca" na barra de cima, pra visitante, aluno ainda sem rosto
-- e prestador de serviço. Fica registrado quem abriu e quando: catraca que
-- abre no grito, sem rastro, vira porta escancarada.
-- =========================================================

create table if not exists academia_liberacoes (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  motivo     text,
  criado_em  timestamptz not null default now(),
  criado_por uuid references auth.users(id) on delete set null
);

create index if not exists academia_liberacoes_empresa_idx on academia_liberacoes (empresa_id, criado_em desc);

alter table academia_liberacoes enable row level security;

drop policy if exists "academia_liberacoes loja le" on academia_liberacoes;
create policy "academia_liberacoes loja le" on academia_liberacoes
  for select to authenticated using (empresa_id = current_empresa_id());

drop policy if exists "academia_liberacoes loja grava" on academia_liberacoes;
create policy "academia_liberacoes loja grava" on academia_liberacoes
  for insert to authenticated with check (empresa_id = current_empresa_id());

comment on table academia_liberacoes is
  'Aberturas manuais da catraca (botão da barra de cima): visitante, aluno sem rosto, prestador (mig 0295).';
