-- Pedido mínimo para ENTREGA (vale só delivery, conta o subtotal dos produtos).
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS pedido_minimo numeric(10,2) NOT NULL DEFAULT 0;
