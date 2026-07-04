-- Horário de disponibilidade por categoria. NULL = sempre disponível.
-- Ex.: Quentinhas 10:00-14:00, Janta 17:00-22:00. Suporta janela que vira a noite
-- (fim < inicio, ex.: 22:00-02:00) — a lógica de comparação trata isso no app.
ALTER TABLE public.categorias
  ADD COLUMN IF NOT EXISTS hora_inicio time,
  ADD COLUMN IF NOT EXISTS hora_fim    time;
