-- 0208: franquia mensal e saldo do assistente de IA
--
-- O problema: cada pergunta ao assistente custa dinheiro de verdade (API da
-- Anthropic, em dólar). Se o lojista se acostumar a só perguntar — em vez de
-- abrir as telas — o custo cresce sem teto e come a mensalidade. É bom que ele
-- se acostume; só não pode sair de graça.
--
-- A regra: cada loja tem R$ 5,00 de uso por mês incluídos na mensalidade. Passou
-- disso, sai do saldo que ela comprou. Sem saldo, o assistente para e explica.
--
-- O preço é o CUSTO REAL da pergunta convertido em real, mais 20%. Ou seja:
-- pergunta barata (cache quente) desconta pouco, pergunta cara desconta mais.
-- Cotação e margem ficam em config_global pra dar pra corrigir o dólar sem
-- precisar de deploy.

ALTER TABLE public.empresas
  -- Saldo comprado, em centavos. Inteiro de propósito: dinheiro em `numeric`
  -- somado repetidamente acumula dízima e o saldo passa a nunca zerar direito.
  ADD COLUMN IF NOT EXISTS ia_saldo_centavos    integer NOT NULL DEFAULT 0,
  -- Franquia mensal por loja. Fica por loja (e não fixa no código) pra dar mais
  -- pra uma rede grande, ou zerar pra quem abusar, sem mexer em ninguém.
  ADD COLUMN IF NOT EXISTS ia_franquia_centavos integer NOT NULL DEFAULT 500;

ALTER TABLE public.assistente_conversas
  -- Quanto ESTA pergunta custou pra loja (já com a margem). É a coluna que a
  -- conta do mês soma — não a custo_usd, que é o meu custo.
  ADD COLUMN IF NOT EXISTS custo_brl        numeric(10,4) NOT NULL DEFAULT 0,
  -- Quanto saiu do saldo comprado (o resto veio da franquia do mês).
  ADD COLUMN IF NOT EXISTS pago_com_saldo   numeric(10,4) NOT NULL DEFAULT 0;

INSERT INTO public.config_global (chave, valor) VALUES
  ('ia_cotacao_usd', '5.50'),   -- quantos reais vale 1 dólar
  ('ia_margem',      '1.20')    -- 20% em cima do custo
ON CONFLICT (chave) DO NOTHING;

-- Extrato do saldo: toda entrada e saída, com o saldo que ficou depois. Sem o
-- `saldo_depois` gravado, conferir uma reclamação de "sumiu meu saldo" vira
-- refazer a conta inteira de cabeça.
CREATE TABLE IF NOT EXISTS public.ia_saldo_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo           text NOT NULL CHECK (tipo IN ('credito', 'debito', 'ajuste')),
  valor_centavos integer NOT NULL,
  saldo_depois   integer NOT NULL,
  descricao      text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_saldo_log_empresa
  ON public.ia_saldo_log(empresa_id, created_at DESC);

ALTER TABLE public.ia_saldo_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ia_saldo_log_loja ON public.ia_saldo_log;
CREATE POLICY ia_saldo_log_loja ON public.ia_saldo_log
  FOR SELECT TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS ia_saldo_log_super_admin ON public.ia_saldo_log;
CREATE POLICY ia_saldo_log_super_admin ON public.ia_saldo_log
  FOR ALL TO authenticated
  USING      (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

-- Mexer no saldo é sempre por aqui. Ler-somar-gravar no cliente perderia
-- lançamento quando duas perguntas chegam juntas; o UPDATE ... RETURNING faz
-- tudo numa tacada só, com o banco segurando a linha.
CREATE OR REPLACE FUNCTION public.ia_mover_saldo(
  p_empresa_id uuid,
  p_centavos   integer,        -- positivo credita, negativo debita
  p_tipo       text,
  p_descricao  text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_saldo integer;
BEGIN
  UPDATE empresas
     -- Nunca deixa negativo: a última pergunta do saldo pode estourar uns
     -- centavos, e saldo negativo confundiria o lojista sem devolver nada.
     SET ia_saldo_centavos = GREATEST(0, ia_saldo_centavos + p_centavos)
   WHERE id = p_empresa_id
   RETURNING ia_saldo_centavos INTO v_saldo;

  IF v_saldo IS NULL THEN
    RAISE EXCEPTION 'Empresa % nao encontrada', p_empresa_id;
  END IF;

  INSERT INTO ia_saldo_log (empresa_id, tipo, valor_centavos, saldo_depois, descricao)
  VALUES (p_empresa_id, p_tipo, p_centavos, v_saldo, p_descricao);

  RETURN v_saldo;
END $$;

-- Só o Super Admin chama pela API (a edge function usa service role e passa por
-- cima disto). Sem o REVOKE, um lojista poderia se dar saldo pelo PostgREST.
REVOKE ALL ON FUNCTION public.ia_mover_saldo(uuid, integer, text, text) FROM public, anon, authenticated;

COMMENT ON COLUMN public.empresas.ia_franquia_centavos IS
  'Quanto de assistente de IA a loja usa por mes sem pagar. Passou disso, sai do ia_saldo_centavos.';

-- --------------------------------------------------------------------------
-- Correção aplicada logo em seguida: o REVOKE acima travou o lojista, mas
-- travou o Super Admin junto — e é ele quem lança o saldo enquanto a compra
-- por PIX não existe. A permissão passou pra DENTRO da função: passa quem é
-- super_admin, ou a edge function (service role, que não tem auth.uid()).
CREATE OR REPLACE FUNCTION public.ia_mover_saldo(
  p_empresa_id uuid,
  p_centavos   integer,
  p_tipo       text,
  p_descricao  text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_saldo integer;
BEGIN
  IF auth.uid() IS NOT NULL AND current_perfil() <> 'super_admin' THEN
    RAISE EXCEPTION 'Sem permissao para mexer no saldo de IA.';
  END IF;

  UPDATE empresas
     SET ia_saldo_centavos = GREATEST(0, ia_saldo_centavos + p_centavos)
   WHERE id = p_empresa_id
   RETURNING ia_saldo_centavos INTO v_saldo;

  IF v_saldo IS NULL THEN
    RAISE EXCEPTION 'Empresa % nao encontrada', p_empresa_id;
  END IF;

  INSERT INTO ia_saldo_log (empresa_id, tipo, valor_centavos, saldo_depois, descricao)
  VALUES (p_empresa_id, p_tipo, p_centavos, v_saldo, p_descricao);

  RETURN v_saldo;
END $$;

GRANT EXECUTE ON FUNCTION public.ia_mover_saldo(uuid, integer, text, text) TO authenticated;
