-- 0195_pix_dividido_na_mesa.sql
-- Conta dividida no PIX: um QR por pessoa, e a conta so fecha quando todos pagam.
--
-- Na mig 0193 a mesa so podia ter UMA cobranca aberta, do valor cheio. Mas mesa
-- de bar racha: dois amigos, R$ 4,39 cada. Com um QR so, o primeiro paga tudo e
-- o segundo fica devendo pro amigo -- que e exatamente o que o cliente nao quer
-- na hora de pagar.
--
-- Agora cada linha da divisao pode virar o SEU QR. As regras:
--
--   * Varias cobrancas abertas por mesa (caiu o indice unico).
--   * Cobranca paga NAO fecha a conta sozinha: ela so soma. A conta fecha quando
--     o PIX pago cobre o total -- e ai o fechamento sai com uma linha de
--     pagamento por QR, do jeito que o pessoal rachou.
--   * Rachou PIX + dinheiro? Os QR pagos ficam guardados e quem fecha e o
--     atendente, quando receber a parte em dinheiro. O dinheiro do PIX ja esta
--     confirmado; o resto e no olho dele mesmo.
--
-- A soma nunca passa do total: quem cobra e a edge function comanda-pix, que
-- soma o que ja esta aberto e pago antes de criar mais uma.

DROP INDEX IF EXISTS public.idx_comanda_pix_pendente;

CREATE INDEX IF NOT EXISTS idx_comanda_pix_comanda
  ON public.comanda_pix_cobrancas (comanda_id, status);

COMMENT ON COLUMN public.comanda_pix_cobrancas.valor IS
  'Quanto ESTE QR cobra. Na conta dividida e a parte de uma pessoa, nao o total da mesa (mig 0195).';

-- ── Caiu um PIX: soma, e fecha a conta se ja deu o total ────────────────────
CREATE OR REPLACE FUNCTION public.confirmar_pix_comanda(p_mp_payment_id text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_cob      comanda_pix_cobrancas%ROWTYPE;
  v_com      comandas%ROWTYPE;
  v_venda    uuid;
  v_pct      numeric;
  v_subtotal numeric := 0;
  v_base     numeric := 0;
  v_total    numeric := 0;
  v_pago     numeric := 0;
  v_pags     jsonb;
BEGIN
  SELECT * INTO v_cob FROM comanda_pix_cobrancas
  WHERE mp_payment_id = p_mp_payment_id FOR UPDATE;

  IF v_cob.id IS NULL THEN
    RETURN json_build_object('ok', false, 'motivo', 'cobranca_nao_encontrada');
  END IF;
  IF v_cob.status = 'pago' THEN
    -- Aviso repetido do MP: nao e erro, so nao faz nada de novo.
    RETURN json_build_object('ok', true, 'repetido', true, 'venda_id', v_cob.venda_id);
  END IF;

  -- O dinheiro caiu: isto e verdade independente do que acontecer com a mesa.
  UPDATE comanda_pix_cobrancas
     SET status = 'pago', pago_em = now()
   WHERE id = v_cob.id;

  SELECT * INTO v_com FROM comandas WHERE id = v_cob.comanda_id;

  -- Mesa fechada por outro caminho no meio (o pessoal acertou no cartao e o
  -- atendente fechou na mao): o PIX caiu do mesmo jeito e fica registrado, mas
  -- nao vira uma segunda venda. Quem devolve e a loja, pelo estorno.
  IF v_com.id IS NULL OR v_com.status NOT IN ('aberta','aguardando_conferencia') THEN
    RETURN json_build_object('ok', false, 'motivo', 'comanda_ja_fechada');
  END IF;

  -- Quanto a mesa deve, contado aqui (a taxa nao pega item isento -- mig 0192).
  SELECT COALESCE(SUM(preco_unitario * quantidade), 0),
         COALESCE(SUM(preco_unitario * quantidade) FILTER (WHERE isento_taxa IS NOT TRUE), 0)
    INTO v_subtotal, v_base
    FROM comanda_itens WHERE comanda_id = v_cob.comanda_id;

  SELECT COALESCE(taxa_servico_pct, 10) INTO v_pct FROM empresas WHERE id = v_cob.empresa_id;
  v_total := v_subtotal + CASE WHEN v_cob.aplicar_taxa
                               THEN ROUND(v_base * v_pct / 100.0, 2) ELSE 0 END;

  SELECT COALESCE(SUM(valor), 0) INTO v_pago
    FROM comanda_pix_cobrancas
   WHERE comanda_id = v_cob.comanda_id AND status = 'pago';

  -- Ainda falta gente pagar (ou falta a parte em dinheiro): a mesa segue aberta,
  -- com o que ja caiu guardado. Nada de fechar conta pela metade.
  IF v_pago < v_total - 0.05 THEN
    RETURN json_build_object('ok', true, 'parcial', true,
                             'pago', v_pago, 'total', v_total,
                             'comanda_id', v_cob.comanda_id);
  END IF;

  -- Cobriu tudo: fecha com uma linha de pagamento por QR pago -- a conta sai
  -- mostrando como o pessoal rachou, e nao um PIX gigante so.
  SELECT jsonb_agg(jsonb_build_object('forma', 'pix', 'valor', valor) ORDER BY created_at)
    INTO v_pags
    FROM comanda_pix_cobrancas
   WHERE comanda_id = v_cob.comanda_id AND status = 'pago';

  v_venda := fechar_conta_presencial_interno(
    v_cob.comanda_id, v_pags, v_cob.aplicar_taxa, v_cob.cliente_id, v_cob.empresa_id);

  UPDATE comanda_pix_cobrancas
     SET venda_id = v_venda
   WHERE comanda_id = v_cob.comanda_id AND status = 'pago' AND venda_id IS NULL;

  RETURN json_build_object('ok', true, 'venda_id', v_venda, 'comanda_id', v_cob.comanda_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.confirmar_pix_comanda(text) FROM public;
REVOKE EXECUTE ON FUNCTION public.confirmar_pix_comanda(text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.confirmar_pix_comanda(text) TO service_role;

NOTIFY pgrst, 'reload schema';
