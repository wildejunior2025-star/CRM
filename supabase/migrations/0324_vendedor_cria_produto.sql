-- VENDEDOR TAMBÉM CRIA PRODUTO PELA VENDA (13/10/2026)
--
-- "Inventar produto" com a caixinha "Adicionar ao catálogo" marcada dava
-- `new row violates row-level security policy for table "produtos"` pro
-- VENDEDOR. A tela oferecia o botão, o banco recusava — a mesma armadilha da
-- mig 0319 (vendedor lançando entrada de estoque): a rota estava liberada e a
-- RLS não.
--
-- A policy existia, mas só pra UM perfil: "Garcom cria produto pelo salao"
-- exigia `current_perfil() = 'garcom'`. Quem vende no balcão é o VENDEDOR, e
-- ele é justamente quem mais encontra produto fora do cardápio — o cliente
-- pede uma bala, um cigarro avulso, um refrigerante que entrou essa semana.
--
-- Continua valendo o que a policy antiga já garantia, e é o ponto todo dela:
-- INSERT e só. Nem UPDATE nem DELETE. Quem vende pode ACRESCENTAR item ao
-- cardápio da PRÓPRIA loja; mexer no preço do que já existe, ou apagar, segue
-- sendo do admin. Produto novo nasce com `controla_estoque=false` pela tela,
-- então também não bagunça o estoque.

drop policy if exists "Garcom cria produto pelo salao" on public.produtos;
drop policy if exists "Equipe cria produto pela venda" on public.produtos;

create policy "Equipe cria produto pela venda" on public.produtos
  for insert to authenticated
  with check (
    (select current_perfil()) in ('garcom', 'vendedor')
    and empresa_id = (select current_empresa_id())
  );
