-- 0197_garcom_cria_produto.sql
-- Garcom tambem cria produto no catalogo pelo Salao.
--
-- Caso do Saidera (26/08/2026): no "Inventar produto" o garcom so conseguia
-- item avulso -- vale naquela venda e some, nao entra no cardapio. Quem esta
-- no salao e quem vive o caso (chegou prato novo, o dono nao esta na loja),
-- entao ele passa a ter a mesma caixinha "Adicionar ao catalogo" do ADM.
--
-- So INSERT de proposito: a policy "Admin gerencia produtos" continua sendo a
-- unica que faz UPDATE/DELETE. Garcom cria o que falta, mas nao mexe no preco
-- nem apaga produto que ja existe.

drop policy if exists "Garcom cria produto pelo salao" on public.produtos;

create policy "Garcom cria produto pelo salao"
  on public.produtos for insert to authenticated
  with check (current_perfil() = 'garcom' and empresa_id = current_empresa_id());
