-- =========================================================
-- Migration 0071 - Credenciais padrão do app iFood (plataforma)
-- =========================================================
-- O app crm-fwc é Centralizado: o MESMO client_id/secret de produção vale
-- para todos os clientes da FWC. Em vez de colar as credenciais em cada
-- empresa, guardamos uma vez aqui (linha única). A edge function usa essas
-- credenciais como padrão quando a empresa não tem credencial própria — então
-- pra ligar um cliente novo basta informar o merchant_id dele.
--
-- Segurança: só o super_admin enxerga/edita; a edge function lê via
-- service_role (que ignora RLS). O secret NUNCA vai para o frontend.
-- Os valores das credenciais são inseridos fora da migração (não versionado).
-- =========================================================

create table if not exists ifood_app (
  id            smallint     primary key default 1,
  client_id     text,
  client_secret text,
  updated_at    timestamptz  not null default now(),
  constraint ifood_app_singleton check (id = 1)
);

alter table ifood_app enable row level security;

drop policy if exists "Super admin gerencia ifood_app" on ifood_app;
create policy "Super admin gerencia ifood_app"
  on ifood_app for all
  using  (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');
