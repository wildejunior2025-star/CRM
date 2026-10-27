-- 0404 — LIGAÇÃO ENTRE O NOME DA NOTA E O ITEM DO CADASTRO
--
-- 26/10/2026: no cardápio está "Coca zero" e na nota do fornecedor vem "COCA COLA LATA ZERO".
-- Nomes diferentes, mesmo produto. A pessoa liga UMA vez ("este nome da nota é este item") e a
-- ligação fica guardada por loja: da próxima vez que aquele nome aparecer, já se sabe de quem é.
--
-- É também o que o robô que lê a nota vai consultar ANTES de tentar adivinhar pelo nome
-- (apelido_norm = o nome da nota sem acento/pontuação, minúsculo, espaços simples).
--
-- item_id aponta pra produtos OU materias_primas conforme `tipo`, então não tem FK: a tela só
-- usa a ligação se o item ainda existir.

create table if not exists item_apelidos (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null default current_empresa_id() references empresas(id) on delete cascade,
  apelido      text not null check (length(btrim(apelido)) > 0),   -- como veio escrito na nota
  apelido_norm text not null,
  tipo         text not null check (tipo in ('produto', 'materia')),
  item_id      uuid not null,
  vezes        integer not null default 1,
  criado_por   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  unique (empresa_id, apelido_norm)
);

create index if not exists idx_item_apelidos_item on item_apelidos (empresa_id, tipo, item_id);

alter table item_apelidos enable row level security;
drop policy if exists item_apelidos_admin on item_apelidos;
create policy item_apelidos_admin on item_apelidos for all to authenticated
  using (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin')
  with check (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin');
