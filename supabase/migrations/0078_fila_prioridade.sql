-- =========================================================
-- Migration 0078 - Fila de espera com prioridade (lei do idoso/PCD)
-- =========================================================
-- A fila de espera do salão passa a ter prioridade. Cada pessoa recebe um
-- tipo (normal, idoso 60+, idoso 80+, PCD, gestante, criança de colo, obeso).
-- A lei não fixa proporção, então a loja define quantos prioritários passam
-- para cada normal (fila_prioridade_ratio; padrão 2 = a cada 2 prioritários,
-- passa 1 normal), pra fila dos normais não travar.
-- =========================================================

alter table fila_espera
  add column if not exists prioridade text not null default 'normal';

alter table empresas
  add column if not exists fila_prioridade_ratio int not null default 2;
