-- 0140_materia_prima_estoque.sql
-- Controle de estoque das MATÉRIAS-PRIMAS (insumos da ficha técnica): entradas
-- (comprei), saídas (usei) e acertos. Objetivo: saber quanto tem de cada insumo e
-- quanto de dinheiro está parado em matéria-prima (Σ quantidade × custo).
-- A quantidade é guardada na MESMA unidade de compra da matéria-prima (ex.: kg).

CREATE TABLE IF NOT EXISTS public.materia_prima_movimentos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL DEFAULT current_empresa_id(),
  materia_prima_id uuid NOT NULL REFERENCES public.materias_primas(id) ON DELETE CASCADE,
  tipo             text NOT NULL,          -- 'entrada' | 'saida' | 'ajuste'
  quantidade       numeric NOT NULL DEFAULT 0,
  observacao       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.materia_prima_movimentos ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='materia_prima_movimentos' AND policyname='mp_mov_admin') THEN
    CREATE POLICY mp_mov_admin ON public.materia_prima_movimentos
      FOR ALL TO authenticated
      USING (current_perfil() = 'admin' AND empresa_id = current_empresa_id())
      WITH CHECK (current_perfil() = 'admin' AND empresa_id = current_empresa_id());
  END IF;
END $$;

-- Saldo por matéria-prima (entrada + / saída − / ajuste +). Filtra pela empresa do
-- usuário logado, igual à view estoque_saldo.
CREATE OR REPLACE VIEW public.materia_prima_saldo AS
 SELECT mp.id AS materia_prima_id,
    mp.nome,
    mp.unidade,
    mp.custo,
    COALESCE(sum(
        CASE
            WHEN mv.tipo = 'entrada'::text THEN mv.quantidade
            WHEN mv.tipo = 'saida'::text THEN - mv.quantidade
            WHEN mv.tipo = 'ajuste'::text THEN mv.quantidade
            ELSE 0::numeric
        END), 0::numeric) AS quantidade_atual
   FROM materias_primas mp
     LEFT JOIN materia_prima_movimentos mv ON mv.materia_prima_id = mp.id
  WHERE mp.empresa_id = current_empresa_id()
  GROUP BY mp.id, mp.nome, mp.unidade, mp.custo;

GRANT SELECT ON public.materia_prima_saldo TO authenticated;
