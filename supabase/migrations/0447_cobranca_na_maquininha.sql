-- 0447_cobranca_na_maquininha.sql
-- Cobrar a mesa na maquininha (Mercado Pago Point) pelo sistema.
--
-- O garcom aperta "Cobrar na maquininha", o valor da conta aparece na Point da
-- loja, o cliente passa o cartao (ou paga o QR da propria maquininha) e a mesa
-- fecha sozinha quando o Mercado Pago avisa que aprovou.
--
-- O desenho e o mesmo do PIX da mesa (mig 0193/0195), de proposito: a cobranca
-- da maquininha mora na MESMA tabela das cobrancas de PIX, so que marcada como
-- canal 'maquininha'. Com isso vem de graca tudo o que o PIX ja resolve:
--   * a conta rachada (uma parte no PIX, outra no cartao) soma junto;
--   * a soma nunca passa do total da conta;
--   * a mesa so fecha quando o que caiu cobre tudo, com uma linha de pagamento
--     por cobranca, cada uma com a forma certa (pix / debito / credito).
--
-- A conexao da loja com a maquininha e um OAuth SEPARADO do PIX. O app do PIX
-- ("FWC Inter CRM") e de pagamentos online e o Mercado Pago nao deixa ele mexer
-- em maquininha (403 PolicyAgent, teste de 11/11). A maquininha usa o app
-- "FWC Inter Maquininha" (Point Platform). Por isso os tokens ficam noutra
-- tabela: a loja pode ter um, o outro, ou os dois.

-- ── Conexao da loja com o app da maquininha ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mercadopago_point_contas (
  empresa_id    uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  mp_user_id    text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  connected_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Token de dinheiro: RLS ligada e SEM policy. So o service_role (edge function) le.
ALTER TABLE public.mercadopago_point_contas ENABLE ROW LEVEL SECURITY;

-- O que a tela pode saber: conectado ou nao.
ALTER TABLE public.empresas ADD COLUMN IF NOT EXISTS mp_point_conectado boolean NOT NULL DEFAULT false;

-- O mesmo callback de OAuth atende os dois apps; o state diz qual era.
ALTER TABLE public.mercadopago_oauth_state ADD COLUMN IF NOT EXISTS app text NOT NULL DEFAULT 'pix';

-- ── As maquininhas da loja ─────────────────────────────────────────────────
-- Generica de proposito (provedor): hoje so Mercado Pago, depois Stone/PagBank.
CREATE TABLE IF NOT EXISTS public.maquininhas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  provedor    text NOT NULL DEFAULT 'mercadopago',
  terminal_id text NOT NULL,           -- ex.: NEWLAND_N950__N950NCB801293324
  apelido     text,                    -- "Caixa", "Garçom 1"
  modo        text,                    -- PDV | STANDALONE | UNDEFINED (o que o MP disse por ultimo)
  ativa       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provedor, terminal_id)
);
CREATE INDEX IF NOT EXISTS idx_maquininhas_empresa ON public.maquininhas (empresa_id);

ALTER TABLE public.maquininhas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS maquininhas_le ON public.maquininhas;
CREATE POLICY maquininhas_le ON public.maquininhas
  FOR SELECT USING (empresa_id = current_empresa_id());
-- Apelido e liga/desliga a loja muda pela tela. Quem CRIA a linha e a edge
-- function (ela pergunta ao Mercado Pago quais maquininhas a conta tem).
DROP POLICY IF EXISTS maquininhas_edita ON public.maquininhas;
CREATE POLICY maquininhas_edita ON public.maquininhas
  FOR UPDATE USING (empresa_id = current_empresa_id())
  WITH CHECK (empresa_id = current_empresa_id());

-- ── A cobranca da maquininha mora junto com a do PIX ───────────────────────
ALTER TABLE public.comanda_pix_cobrancas
  ADD COLUMN IF NOT EXISTS canal         text NOT NULL DEFAULT 'pix',   -- pix | maquininha
  ADD COLUMN IF NOT EXISTS forma         text,                          -- pix | debito | credito (como foi pago)
  ADD COLUMN IF NOT EXISTS mp_order_id   text,                          -- ORD... (API Orders do Point)
  ADD COLUMN IF NOT EXISTS maquininha_id uuid REFERENCES maquininhas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status_detalhe text;                         -- motivo do MP quando nao aprova

CREATE UNIQUE INDEX IF NOT EXISTS idx_comanda_cob_order
  ON public.comanda_pix_cobrancas (mp_order_id) WHERE mp_order_id IS NOT NULL;

-- Uma maquininha so processa uma cobranca por vez. Duas abertas na mesma
-- maquininha = a segunda some da tela da Point e a mesa fica esperando a toa.
CREATE UNIQUE INDEX IF NOT EXISTS idx_maquininha_uma_por_vez
  ON public.comanda_pix_cobrancas (maquininha_id)
  WHERE status = 'pendente' AND maquininha_id IS NOT NULL;

COMMENT ON COLUMN public.comanda_pix_cobrancas.canal IS
  'pix = QR do PIX online (mig 0193); maquininha = cobranca mandada pra Point (mig 0447).';

-- ── Caiu um pagamento (PIX ou maquininha): soma, e fecha se ja deu o total ──
-- Era o corpo do confirmar_pix_comanda (mig 0195), agora pela ID da cobranca,
-- e cada linha de pagamento sai com a forma de verdade (antes era sempre 'pix').
CREATE OR REPLACE FUNCTION public.comanda_cobranca_paga(p_cob_id uuid)
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
  SELECT * INTO v_cob FROM comanda_pix_cobrancas WHERE id = p_cob_id FOR UPDATE;

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

  -- Mesa fechada por outro caminho no meio: o dinheiro fica registrado, mas nao
  -- vira uma segunda venda. Quem devolve e a loja, pelo estorno.
  IF v_com.id IS NULL OR v_com.status NOT IN ('aberta','aguardando_conferencia') THEN
    RETURN json_build_object('ok', false, 'motivo', 'comanda_ja_fechada');
  END IF;

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

  IF v_pago < v_total - 0.05 THEN
    RETURN json_build_object('ok', true, 'parcial', true,
                             'pago', v_pago, 'total', v_total,
                             'comanda_id', v_cob.comanda_id);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('forma', COALESCE(forma, 'pix'), 'valor', valor) ORDER BY created_at)
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

REVOKE EXECUTE ON FUNCTION public.comanda_cobranca_paga(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.comanda_cobranca_paga(uuid) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.comanda_cobranca_paga(uuid) TO service_role;

-- A porta do PIX continua com o mesmo nome e o mesmo jeito de chamar.
CREATE OR REPLACE FUNCTION public.confirmar_pix_comanda(p_mp_payment_id text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM comanda_pix_cobrancas WHERE mp_payment_id = p_mp_payment_id;
  IF v_id IS NULL THEN
    RETURN json_build_object('ok', false, 'motivo', 'cobranca_nao_encontrada');
  END IF;
  RETURN comanda_cobranca_paga(v_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.confirmar_pix_comanda(text) FROM public;
REVOKE EXECUTE ON FUNCTION public.confirmar_pix_comanda(text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.confirmar_pix_comanda(text) TO service_role;

-- A porta da maquininha: grava COMO foi pago (debito/credito/pix) antes de somar.
CREATE OR REPLACE FUNCTION public.confirmar_maquininha_comanda(p_order_id text, p_forma text, p_payment_id text DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM comanda_pix_cobrancas WHERE mp_order_id = p_order_id FOR UPDATE;
  IF v_id IS NULL THEN
    RETURN json_build_object('ok', false, 'motivo', 'cobranca_nao_encontrada');
  END IF;
  UPDATE comanda_pix_cobrancas
     SET forma = CASE WHEN p_forma IN ('pix','debito','credito','cartao') THEN p_forma ELSE 'cartao' END,
         mp_payment_id = COALESCE(mp_payment_id, p_payment_id)
   WHERE id = v_id AND status = 'pendente';
  RETURN comanda_cobranca_paga(v_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.confirmar_maquininha_comanda(text, text, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.confirmar_maquininha_comanda(text, text, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.confirmar_maquininha_comanda(text, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
