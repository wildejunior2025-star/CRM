-- 0403 — CADASTRO DE FORNECEDORES
--
-- 26/10/2026: o "Lançar compra" (0402) pedia o fornecedor como texto livre. Digitar "Atacado X"
-- num dia e "Atacado X Ltda" no outro dividia o gasto em dois fornecedores nos relatórios.
-- Agora o fornecedor é escolhido de uma lista da loja, ou cadastrado na hora se não existir.
--
-- A conta continua guardando o NOME em contas_financeiras.pessoa (texto), de propósito: as telas
-- de Contas a pagar já leem esse campo, e renomear um fornecedor aqui não reescreve o passado.
--
-- Backfill: os nomes que a loja já usou nas contas a pagar viram fornecedores cadastrados.

create table if not exists fornecedores (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null default current_empresa_id() references empresas(id) on delete cascade,
  nome       text not null check (length(btrim(nome)) > 0),
  telefone   text,
  ativo      boolean not null default true,
  created_at timestamptz not null default now()
);

-- "Atacado X" e "atacado x " são o mesmo fornecedor.
create unique index if not exists uq_fornecedores_nome
  on fornecedores (empresa_id, lower(btrim(nome)));

alter table fornecedores enable row level security;
drop policy if exists fornecedores_admin on fornecedores;
create policy fornecedores_admin on fornecedores for all to authenticated
  using (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin')
  with check (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin');

insert into fornecedores (empresa_id, nome)
select distinct on (empresa_id, lower(btrim(pessoa))) empresa_id, btrim(pessoa)
from contas_financeiras
where tipo = 'pagar' and pessoa is not null and length(btrim(pessoa)) > 0
order by empresa_id, lower(btrim(pessoa)), created_at desc
on conflict do nothing;
