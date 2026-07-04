-- Pausar a subcategoria inteira de complementos (ex.: pausar o grupo "Feijão"
-- some com todas as opções de feijão de uma vez na loja/bot), estilo iFood.
ALTER TABLE public.complemento_grupos
  ADD COLUMN IF NOT EXISTS disponivel boolean NOT NULL DEFAULT true;
