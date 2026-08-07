-- PIX DO FIADO PELO LINK DO CLIENTE (mig 0147)
--
-- O cliente abre o link dele, vê que está devendo, e paga na hora: o sistema gera
-- um PIX (QR + copia e cola) na conta do Mercado Pago DA LOJA. Quando o MP
-- confirma, o recebimento é lançado sozinho e a dívida cai — igualzinho ao que a
-- equipe faz na tela do Fiado, só que sem ninguém precisar digitar nada.
--
-- Decidido com o Wilde (07/08/2026):
--   • serve pra pagar O FIADO (não a comanda aberta — essa continua com a equipe);
--   • ele pode pagar tudo ou digitar um valor menor (pagamento parcial);
--   • quando o MP confirma, o sistema DÁ BAIXA SOZINHO;
--   • a loja vê na tela do Fiado, no Caixa do dia, num aviso no Salão e no WhatsApp.
--
-- Como isso cai no lugar certo sem gambiarra: o recebimento entra em `pagamentos`
-- com observacao = 'Recebimento de fiado' e forma = 'pix' — que é EXATAMENTE o que
-- a tela do Fiado filtra e o que a view caixa_resumo soma como "fiado em PIX".
-- Mudou lá, muda aqui.
--
-- ⚠️ Só funciona pra loja que conectou o Mercado Pago DELA. Sem conta conectada a
-- cobrança nem é criada — dinheiro de cliente não pode cair na conta central.

-- ── 1) As cobranças geradas pelo link ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cliente_pix_cobrancas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id     uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  valor          numeric(10,2) NOT NULL CHECK (valor > 0),
  -- pendente → pago | expirado. Só a função de confirmação muda pra 'pago'.
  status         text NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente','pago','expirado')),
  mp_payment_id  text UNIQUE,
  qr_code        text,          -- o "copia e cola"
  qr_code_base64 text,          -- a imagem do QR
  pagamento_id   uuid REFERENCES public.pagamentos(id) ON DELETE SET NULL,
  expira_em      timestamptz,
  pago_em        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cliente_pix_cobrancas IS
  'PIX que o cliente gerou pelo link dele pra pagar o fiado (mig 0149).';

CREATE INDEX IF NOT EXISTS idx_cpix_empresa_pago
  ON public.cliente_pix_cobrancas(empresa_id, pago_em DESC) WHERE status = 'pago';
CREATE INDEX IF NOT EXISTS idx_cpix_cliente
  ON public.cliente_pix_cobrancas(cliente_id, created_at DESC);

ALTER TABLE public.cliente_pix_cobrancas ENABLE ROW LEVEL SECURITY;

-- A loja enxerga as cobranças dela (é assim que o aviso do Salão funciona).
-- Ninguém escreve pela API: quem cria é a edge function e quem confirma é a
-- função abaixo, as duas com service_role.
DROP POLICY IF EXISTS "Empresa ve os pix do link dela" ON public.cliente_pix_cobrancas;
CREATE POLICY "Empresa ve os pix do link dela"
  ON public.cliente_pix_cobrancas FOR SELECT
  TO authenticated
  USING (empresa_id = current_empresa_id());

-- ── 2) O cliente pergunta "já caiu?" ─────────────────────────────────────────
-- Sem login: o token é a senha. Só devolve a cobrança se ela for do dono do token.
CREATE OR REPLACE FUNCTION public.cliente_pix_status(p_token text, p_cobranca uuid)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cliente uuid;
  v_cob     cliente_pix_cobrancas%ROWTYPE;
BEGIN
  SELECT id INTO v_cliente FROM clientes WHERE token = p_token;
  IF v_cliente IS NULL THEN RAISE EXCEPTION 'Link não encontrado.'; END IF;

  SELECT * INTO v_cob FROM cliente_pix_cobrancas
   WHERE id = p_cobranca AND cliente_id = v_cliente;
  IF v_cob.id IS NULL THEN RAISE EXCEPTION 'Cobrança não encontrada.'; END IF;

  RETURN json_build_object(
    'status',      v_cob.status,
    'valor',       v_cob.valor,
    'expira_em',   v_cob.expira_em,
    'saldo_fiado', COALESCE((SELECT saldo_fiado FROM clientes_saldo_fiado WHERE cliente_id = v_cliente), 0)
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cliente_pix_status(text, uuid) FROM public;
GRANT  EXECUTE ON FUNCTION public.cliente_pix_status(text, uuid) TO anon, authenticated;

-- ── 3) O Mercado Pago confirmou: dá baixa no fiado ───────────────────────────
-- Chamada só pelo webhook (service_role). Tudo numa transação e IDEMPOTENTE: a
-- trava é o status='pendente' + FOR UPDATE, então webhook repetido (o MP repete
-- mesmo) não lança o recebimento duas vezes.
CREATE OR REPLACE FUNCTION public.confirmar_pix_fiado(p_mp_payment_id text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cob   cliente_pix_cobrancas%ROWTYPE;
  v_caixa uuid;
  v_pag   uuid;
  v_nome  text;
  v_fone  text;
  v_loja  text;
BEGIN
  SELECT * INTO v_cob FROM cliente_pix_cobrancas
   WHERE mp_payment_id = p_mp_payment_id AND status = 'pendente'
   FOR UPDATE;
  IF v_cob.id IS NULL THEN
    RETURN json_build_object('ok', false, 'motivo', 'ja_processado_ou_inexistente');
  END IF;

  -- Cai no caixa que estiver aberto na loja. Se ninguém abriu caixa (cliente pagou
  -- de madrugada, por ex.), o recebimento vale do mesmo jeito e abate a dívida —
  -- só não entra em caixa nenhum. O aviso avisa que foi assim.
  SELECT id INTO v_caixa FROM caixas
   WHERE empresa_id = v_cob.empresa_id AND status = 'aberto'
   ORDER BY aberto_em DESC LIMIT 1;

  -- observacao e forma são o que a tela do Fiado e a caixa_resumo procuram.
  INSERT INTO pagamentos (empresa_id, cliente_id, valor, forma_pagamento, observacao, caixa_id)
  VALUES (v_cob.empresa_id, v_cob.cliente_id, v_cob.valor, 'pix', 'Recebimento de fiado', v_caixa)
  RETURNING id INTO v_pag;

  UPDATE cliente_pix_cobrancas
     SET status = 'pago', pago_em = now(), pagamento_id = v_pag
   WHERE id = v_cob.id;

  SELECT c.nome INTO v_nome FROM clientes c WHERE c.id = v_cob.cliente_id;
  SELECT e.telefone_contato, e.nome INTO v_fone, v_loja FROM empresas e WHERE e.id = v_cob.empresa_id;

  RETURN json_build_object(
    'ok', true,
    'cliente_nome',  v_nome,
    'valor',         v_cob.valor,
    'caixa_aberto',  v_caixa IS NOT NULL,
    'saldo_restante', COALESCE((SELECT saldo_fiado FROM clientes_saldo_fiado WHERE cliente_id = v_cob.cliente_id), 0),
    'telefone_loja', v_fone,
    'loja_nome',     v_loja
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.confirmar_pix_fiado(text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.confirmar_pix_fiado(text) TO service_role;
