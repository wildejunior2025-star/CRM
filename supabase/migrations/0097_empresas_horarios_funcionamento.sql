-- Grade semanal de funcionamento (estilo iFood). Array de 7 (0=domingo .. 6=sábado),
-- cada dia = { aberto: bool, periodos: [{ i: "HH:MM", f: "HH:MM" }, ...] }.
-- NULL = sem grade (usa o comportamento antigo: só o toggle delivery_ativo).
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS horarios_funcionamento jsonb;
