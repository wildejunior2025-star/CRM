-- Gastar o crédito no delivery (Fase 4). A 0174 fez a carteira, a 0176 a encheu.
--
-- Molde da 0048 (resgate de pontos): quem manda é UM trigger só, e não a tela.
-- Se o débito ficasse no app, bastaria mexer no navegador pra gastar um saldo
-- que não existe — e o PIX, que é confirmado por webhook, nem passa pela tela
-- de novo.
--
-- TRÊS MOMENTOS, um por forma de pagamento:
--   dinheiro/cartão → debita na CRIAÇÃO do pedido (a venda já é firme)
--   pix             → debita só quando o pagamento CONFIRMA. Antes disso o
--                     pedido pode morrer sem ninguém avisar, e o saldo teria
--                     sumido à toa.
--   cancelado       → devolve, se já tinha sido debitado
--
-- `cashback_debitado` é o que impede debitar duas vezes e devolver o que nunca
-- saiu: sem essa marca, cada UPDATE no pedido mexeria no saldo de novo.

ALTER TABLE public.pedidos_delivery
  ADD COLUMN IF NOT EXISTS cashback_usado     numeric NOT NULL DEFAULT 0;
ALTER TABLE public.pedidos_delivery
  ADD COLUMN IF NOT EXISTS cashback_debitado  boolean NOT NULL DEFAULT false;

-- ── Saldo pelo telefone ──────────────────────────────────────────────────────
-- O checkout da loja online não tem login: o cliente só é criado no momento em
-- que o pedido é enviado. Pra oferecer o crédito ANTES disso, a única chave que
-- existe na tela é o telefone que ele acabou de digitar.
--
-- Devolve só o saldo, nunca nome nem histórico: o telefone é palpite fácil, e o
-- que vaza aqui não pode ser mais do que "existe crédito nesta loja".
CREATE OR REPLACE FUNCTION public.cashback_por_telefone(p_empresa_id uuid, p_telefone text)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_fone text := regexp_replace(COALESCE(p_telefone, ''), '\D', '', 'g');
  v_cli  uuid;
  v_cfg  fidelidade_config%ROWTYPE;
BEGIN
  IF length(v_fone) < 10 THEN RETURN 0; END IF;

  SELECT * INTO v_cfg FROM fidelidade_config WHERE empresa_id = p_empresa_id;
  IF v_cfg.empresa_id IS NULL OR NOT v_cfg.ativo THEN RETURN 0; END IF;

  SELECT id INTO v_cli FROM clientes
  WHERE empresa_id = p_empresa_id
    AND regexp_replace(COALESCE(telefone, ''), '\D', '', 'g') = v_fone
  LIMIT 1;
  IF v_cli IS NULL THEN RETURN 0; END IF;

  RETURN fidelidade_saldo_de(p_empresa_id, v_cli);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cashback_por_telefone(uuid, text) FROM public;
GRANT  EXECUTE ON FUNCTION public.cashback_por_telefone(uuid, text) TO anon, authenticated;

-- Saldo válido de um cliente, sem depender de quem está logado.
-- O `fidelidade_saldo` da 0174 usa current_empresa_id(), que não existe pro
-- visitante anônimo da loja online — por isso esta versão recebe a empresa.
CREATE OR REPLACE FUNCTION public.fidelidade_saldo_de(p_empresa_id uuid, p_cliente_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT GREATEST(0, ROUND(
    COALESCE((SELECT saldo FROM creditos_cliente
               WHERE empresa_id = p_empresa_id AND cliente_id = p_cliente_id), 0)
    -
    COALESCE((SELECT SUM(valor) FROM creditos_movimentos
               WHERE empresa_id = p_empresa_id
                 AND cliente_id = p_cliente_id
                 AND tipo = 'credito'
                 AND expira_em IS NOT NULL
                 AND expira_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0)
  , 2));
$function$;

GRANT EXECUTE ON FUNCTION public.fidelidade_saldo_de(uuid, uuid) TO anon, authenticated;

-- ── O trigger que debita e devolve ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_cashback_pedido()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_saldo numeric;
BEGIN
  -- ── Criação ────────────────────────────────────────────────────────────
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.cashback_usado, 0) <= 0 THEN RETURN NEW; END IF;

    IF NEW.cliente_id IS NULL THEN
      RAISE EXCEPTION 'Nao foi possivel identificar o cliente para usar o credito.';
    END IF;

    -- O valor vem da tela, então é conferido aqui: sem isto, mexer no
    -- navegador dava desconto de qualquer tamanho.
    v_saldo := fidelidade_saldo_de(NEW.empresa_id, NEW.cliente_id);
    IF NEW.cashback_usado > v_saldo THEN
      RAISE EXCEPTION 'Credito insuficiente: voce tem R$ % e o pedido usou R$ %.',
        TO_CHAR(v_saldo, 'FM999999990.00'), TO_CHAR(NEW.cashback_usado, 'FM999999990.00');
    END IF;

    -- O crédito nunca zera a conta: a loja precisa receber alguma coisa, e
    -- pedido de R$ 0 quebra o PIX e confunde o caixa.
    IF NEW.cashback_usado >= COALESCE(NEW.subtotal, 0) + COALESCE(NEW.taxa_entrega, 0) THEN
      RAISE EXCEPTION 'O credito nao pode cobrir o pedido inteiro.';
    END IF;

    NEW.total := GREATEST(0, ROUND(
      COALESCE(NEW.subtotal, 0) + COALESCE(NEW.taxa_entrega, 0) - NEW.cashback_usado, 2));

    -- PIX espera a confirmação; o resto já é firme.
    IF NEW.forma_pagamento <> 'pix' THEN
      PERFORM fidelidade_debitar(NEW.empresa_id, NEW.cliente_id, NEW.cashback_usado,
                'Desconto no pedido', NULL, NEW.id);
      NEW.cashback_debitado := true;
    END IF;

    RETURN NEW;
  END IF;

  -- ── PIX confirmado: agora sim debita ───────────────────────────────────
  IF COALESCE(NEW.cashback_usado, 0) > 0
     AND NOT COALESCE(NEW.cashback_debitado, false)
     AND NEW.status <> 'cancelado'
     AND (NEW.pix_status = 'pago' OR NEW.mp_payment_status = 'approved'
          OR (OLD.status = 'aguardando_pagamento' AND NEW.status <> 'aguardando_pagamento')) THEN
    PERFORM fidelidade_debitar(NEW.empresa_id, NEW.cliente_id, NEW.cashback_usado,
              'Desconto no pedido', NULL, NEW.id);
    NEW.cashback_debitado := true;
    RETURN NEW;
  END IF;

  -- ── Cancelado: devolve o que saiu ──────────────────────────────────────
  IF NEW.status = 'cancelado' AND COALESCE(OLD.status, '') <> 'cancelado'
     AND COALESCE(NEW.cashback_debitado, false) THEN
    PERFORM fidelidade_estornar(NEW.empresa_id, NEW.cliente_id, NEW.cashback_usado,
              'Pedido cancelado', NEW.id);
    NEW.cashback_debitado := false;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_cashback_pedido ON public.pedidos_delivery;
CREATE TRIGGER trg_cashback_pedido
  BEFORE INSERT OR UPDATE ON public.pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION public.fn_cashback_pedido();
