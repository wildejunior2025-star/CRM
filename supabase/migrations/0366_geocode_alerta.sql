-- 0366_geocode_alerta.sql
-- Um aviso por dia, no maximo, quando o consumo do Google passa do limite
-- (funcao geocodificar-google manda o WhatsApp pro dono da FWC).
CREATE TABLE IF NOT EXISTS public.geocode_alerta (
  dia        date PRIMARY KEY,
  total      integer NOT NULL,
  enviado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.geocode_alerta ENABLE ROW LEVEL SECURITY;
NOTIFY pgrst, 'reload schema';
