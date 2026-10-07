-- =========================================================
-- Migration 0297 - Perfil "aluno"
-- =========================================================
-- A academia tem um público novo: o aluno. Ele entra no mesmo sistema, com a
-- matrícula de apelido, e só enxerga a área dele (como o garçom só vê o
-- salão). A lista de perfis era fechada e barrava a criação das contas.
-- =========================================================

alter table profiles drop constraint if exists profiles_perfil_check;

alter table profiles add constraint profiles_perfil_check
  check (perfil = any (array[
    'admin', 'vendedor', 'garcom', 'cozinheiro', 'entregador', 'cliente', 'super_admin', 'aluno'
  ]));
