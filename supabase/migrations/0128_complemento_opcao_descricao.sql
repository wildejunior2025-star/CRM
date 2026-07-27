-- Descrição da opção de complemento (o que vai no sabor da pizza).
-- Os sabores da "Pizza 2 Sabores" são opções de complemento, não produtos do cardápio,
-- então a loja precisa de um lugar pra escrever os ingredientes de cada sabor.
-- Vazio = a loja online continua puxando a descrição do produto de mesmo nome.
alter table public.complemento_opcoes
  add column if not exists descricao text;

comment on column public.complemento_opcoes.descricao is
  'Ingredientes/descrição da opção, mostrada embaixo do nome na loja online. Vazio = usa a descrição do produto de mesmo nome, se existir.';
