-- 0365_geocode_cache.sql
-- Cache do geocodificador do Google (funcao geocodificar-google).
--
-- O Google cobra por consulta e os termos dele limitam guardar o ponto: o cache
-- vale 30 dias (a funcao ignora linha mais velha) e serve so pra nao pagar duas
-- vezes pelo MESMO endereco — a mesma rua repete o tempo todo no delivery.
--
-- Sem policy de proposito: so a funcao (service_role) le e grava. Nenhuma loja
-- precisa ver nem editar isto.

CREATE TABLE IF NOT EXISTS public.geocode_cache (
  chave      text PRIMARY KEY,
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  precisao   text,
  formatado  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.geocode_cache ENABLE ROW LEVEL SECURITY;

-- Consumo por loja/dia: teto simples contra loop ou abuso (a funcao confere).
CREATE TABLE IF NOT EXISTS public.geocode_uso (
  empresa_id uuid NOT NULL,
  dia        date NOT NULL DEFAULT current_date,
  consultas  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (empresa_id, dia)
);

ALTER TABLE public.geocode_uso ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
