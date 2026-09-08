-- 0246_complemento_vai_pro_ifood.sql
-- Guarda o vínculo entre o complemento daqui e o do iFood.
--
-- "Enviar da minha loja pro iFood" mandava nome, descrição, preço e foto, mas
-- deixava os complementos pra trás: no iFood o item subia pelado, sem "escolha
-- o queijo", sem "com ou sem leite". Quem vendia pelo iFood tinha que refazer
-- todos os grupos na mão no Portal do Parceiro.
--
-- O iFood aceita id escolhido por nós no PUT /items — é assim que o item e o
-- produto já funcionam (produtos.ifood_item_id / ifood_product_id). Faltava
-- guardar o mesmo para grupo e opção: sem isso, cada reenvio criaria um grupo
-- novo lá e o cardápio do iFood encheria de "Queijos", "Queijos", "Queijos".
--
-- Fica no GRUPO, não no vínculo produto↔grupo: no iFood o grupo de opções é do
-- restaurante e vários itens apontam pra ele — igual ao daqui, onde o grupo é
-- criado uma vez em Catálogo → Complementos e ligado em muitos produtos pela
-- tabela produto_complemento_grupos.
ALTER TABLE public.complemento_grupos
  ADD COLUMN IF NOT EXISTS ifood_option_group_id uuid;

-- A opção do iFood precisa de DOIS ids: o da opção e o do produto por trás
-- dela. São entidades diferentes lá, e as duas têm que ser estáveis pro reenvio
-- atualizar em vez de duplicar.
ALTER TABLE public.complemento_opcoes
  ADD COLUMN IF NOT EXISTS ifood_option_id uuid,
  ADD COLUMN IF NOT EXISTS ifood_product_id uuid;

COMMENT ON COLUMN public.complemento_grupos.ifood_option_group_id IS
  'id do optionGroup no iFood. Preenchido no primeiro envio; reusado depois pra atualizar em vez de criar outro.';
COMMENT ON COLUMN public.complemento_opcoes.ifood_option_id IS
  'id da option no iFood.';
COMMENT ON COLUMN public.complemento_opcoes.ifood_product_id IS
  'id do product que fica por trás da option no iFood.';
