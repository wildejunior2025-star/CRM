alter table categorias add column if not exists ordem int not null default 0;

-- Inicializa a ordem seguindo o alfabético atual (por empresa), pra não bagunçar
with r as (
  select id, row_number() over (partition by empresa_id order by nome) as rn
  from categorias
)
update categorias c set ordem = r.rn from r where r.id = c.id;

-- Loja Online (anon) precisa ler a ordem das categorias
drop policy if exists "Anon le categorias" on categorias;
create policy "Anon le categorias" on categorias for select to anon using (true);
