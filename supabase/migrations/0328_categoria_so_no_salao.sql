-- Categoria "só no salão": os itens dela vendem no balcão/salão/mesa, mas NÃO
-- aparecem na Loja Online, no app do cliente nem no robô do WhatsApp.
-- Nasceu do Happy Hour da O Braseiro: item de salão vazava pro delivery porque o
-- único interruptor por produto (Pausar) também tira o item do balcão.
ALTER TABLE public.categorias
  ADD COLUMN IF NOT EXISTS oculta_online boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.categorias.oculta_online IS
  'true = itens da categoria não aparecem na Loja Online, no app nem no robô; seguem vendendo no balcão/salão/mesa (mig 0328).';
