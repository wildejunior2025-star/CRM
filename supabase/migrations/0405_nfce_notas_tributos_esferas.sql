-- Divisao do valor aproximado dos tributos por esfera (federal x estadual),
-- pra o cupom mostrar "Federal R$ x  Estadual R$ y" alem do total (mig 0401).
-- O estadual guarda tambem o municipal (zero pra mercadoria) e federal + estadual
-- sempre soma o tributos_valor.
alter table public.nfce_notas
  add column if not exists tributos_federal numeric(12,2),
  add column if not exists tributos_estadual numeric(12,2);
