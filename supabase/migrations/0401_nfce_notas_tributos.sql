-- Valor aproximado dos tributos (Lei 12.741/2012) guardado na nota, pra o cupom
-- fiscal impresso pelo app da impressora poder mostrar ao consumidor.
alter table public.nfce_notas
  add column if not exists tributos_valor numeric(12,2),
  add column if not exists tributos_fonte text;
