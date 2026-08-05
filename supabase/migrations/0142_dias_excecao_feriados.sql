-- 0142_dias_excecao_feriados.sql
-- Feriados e datas especiais: a grade semanal sozinha não dá conta.
--
-- A grade (empresas.horarios_funcionamento) diz o que acontece em toda terça, toda
-- quarta... mas o ano tem exceção: feriado que a loja fecha, feriado que ela abre
-- assim mesmo, folga do dono, dia de festa na cidade. Sem isso, "quantos dias a loja
-- abre no mês" (Despesas & Lucro) contava o feriado como dia normal e a Loja Online
-- ficava aberta num dia em que ninguém ia atender.
--
-- Duas peças, porque existem os dois tipos de loja:
--   • empresas.feriados_fecha — o padrão da casa. false (como nasce) = abre em
--     feriado normalmente, ninguém sente diferença. true = fecha nos feriados
--     nacionais sem precisar cadastrar um por um.
--   • dias_excecao — a exceção da exceção, por DATA:
--       aberto = false → fecha nesse dia (feriado municipal, folga)
--       aberto = true  → ABRE nesse dia, mesmo que a grade/feriado diga que não
--     `periodos` guarda o horário especial do dia ([{i,f}]); nulo = usa o da grade.
--
-- Quem manda, em ordem: dias_excecao > feriado nacional (se feriados_fecha) > grade.
-- A lista de feriados nacionais é calculada no app (src/lib/feriados.js) — não fica
-- no banco pra não precisar de manutenção todo ano.

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS feriados_fecha boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.dias_excecao (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL DEFAULT current_empresa_id() REFERENCES public.empresas(id) ON DELETE CASCADE,
  data       date NOT NULL,
  aberto     boolean NOT NULL DEFAULT false,
  periodos   jsonb,
  motivo     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, data)
);

CREATE INDEX IF NOT EXISTS idx_dias_excecao_empresa_data ON public.dias_excecao(empresa_id, data);

ALTER TABLE public.dias_excecao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Empresa gerencia os proprios dias de excecao" ON public.dias_excecao;
CREATE POLICY "Empresa gerencia os proprios dias de excecao"
  ON public.dias_excecao FOR ALL
  TO authenticated
  USING (empresa_id = current_empresa_id())
  WITH CHECK (empresa_id = current_empresa_id());

-- A Loja Online é pública: o cliente sem login precisa saber que hoje é feriado e a
-- loja não abre, senão ele monta o carrinho pra nada.
DROP POLICY IF EXISTS "Anon ve dias de excecao de loja com delivery" ON public.dias_excecao;
CREATE POLICY "Anon ve dias de excecao de loja com delivery"
  ON public.dias_excecao FOR SELECT
  TO anon
  USING (EXISTS (
    SELECT 1 FROM public.empresas e
    WHERE e.id = dias_excecao.empresa_id
      AND e.status IN ('trial','ativo','atrasado')
      AND e.aceita_delivery = true
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dias_excecao TO authenticated;
GRANT SELECT ON public.dias_excecao TO anon;
