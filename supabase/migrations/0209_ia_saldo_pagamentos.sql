-- 0209: compra de saldo do assistente de IA por PIX
--
-- O PIX cai na CONTA CENTRAL da FWC, não na conta da loja — porque quem paga a
-- API da Anthropic sou eu. É o oposto do PIX de pedido, que vai direto pro
-- lojista. Mesma mecânica dos créditos do bot.

CREATE TABLE IF NOT EXISTS public.ia_saldo_pagamentos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  mp_payment_id  text NOT NULL UNIQUE,
  valor_reais    numeric(10,2) NOT NULL,
  status         text NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente', 'pago', 'cancelado')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ia_saldo_pag_empresa
  ON public.ia_saldo_pagamentos(empresa_id, created_at DESC);

ALTER TABLE public.ia_saldo_pagamentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ia_saldo_pag_loja ON public.ia_saldo_pagamentos;
CREATE POLICY ia_saldo_pag_loja ON public.ia_saldo_pagamentos
  FOR SELECT TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS ia_saldo_pag_super_admin ON public.ia_saldo_pagamentos;
CREATE POLICY ia_saldo_pag_super_admin ON public.ia_saldo_pagamentos
  FOR ALL TO authenticated
  USING      (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

-- Credita o saldo e marca o pagamento numa transação só.
-- Idempotente pela trava status='pendente' + FOR UPDATE: o Mercado Pago manda o
-- mesmo aviso várias vezes, e crédito em dobro é dinheiro perdido de verdade.
-- Também nunca fica 'pago' sem creditar — os dois erros que já morderam os
-- créditos do bot (ver mig 0093).
CREATE OR REPLACE FUNCTION public.confirmar_pagamento_ia(p_mp_payment_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pag public.ia_saldo_pagamentos%ROWTYPE;
  v_saldo integer;
BEGIN
  SELECT * INTO v_pag
  FROM public.ia_saldo_pagamentos
  WHERE mp_payment_id = p_mp_payment_id AND status = 'pendente'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;   -- já processado, ou não é pagamento de IA
  END IF;

  UPDATE empresas
     SET ia_saldo_centavos = ia_saldo_centavos + ROUND(v_pag.valor_reais * 100)::integer
   WHERE id = v_pag.empresa_id
   RETURNING ia_saldo_centavos INTO v_saldo;

  INSERT INTO ia_saldo_log (empresa_id, tipo, valor_centavos, saldo_depois, descricao)
  VALUES (v_pag.empresa_id, 'credito', ROUND(v_pag.valor_reais * 100)::integer, v_saldo,
          'Saldo comprado por PIX');

  UPDATE public.ia_saldo_pagamentos SET status = 'pago' WHERE id = v_pag.id;
  RETURN true;
END $$;
