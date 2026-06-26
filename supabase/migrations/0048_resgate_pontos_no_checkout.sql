-- =========================================================
-- 0048: Usar saldo de pontos como desconto no checkout
-- =========================================================
-- Cliente pode abater o saldo de pontos (cada ponto = valor_resgate_ponto)
-- no pedido. Funciona em todas as formas de pagamento:
--   • dinheiro/cartão → debita os pontos na CRIAÇÃO do pedido
--   • pix             → debita só quando o PIX é confirmado (pix_status='pago')
--   • cancelado       → devolve os pontos se já tinham sido debitados
-- Tudo centralizado num único trigger BEFORE INSERT/UPDATE, então o webhook
-- (status 'aguardando'/'pago') e o refund-pix (status 'cancelado') disparam
-- débito/devolução automaticamente, sem mudar as edge functions.
-- =========================================================

ALTER TABLE pedidos_delivery ADD COLUMN IF NOT EXISTS desconto         numeric  NOT NULL DEFAULT 0;
ALTER TABLE pedidos_delivery ADD COLUMN IF NOT EXISTS pontos_usados    integer  NOT NULL DEFAULT 0;
ALTER TABLE pedidos_delivery ADD COLUMN IF NOT EXISTS pontos_debitados boolean  NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.fn_resgate_pontos_pedido()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_val   numeric;
  v_buyer uuid;
  v_disp  integer;
  v_ded   integer;
BEGIN
  SELECT COALESCE(NULLIF(valor,'')::numeric, 0.02) INTO v_val
  FROM configuracoes_plataforma WHERE chave = 'valor_resgate_ponto';
  v_val := COALESCE(v_val, 0.02);

  v_buyer := NEW.user_id;
  IF v_buyer IS NULL AND NEW.cliente_telefone IS NOT NULL THEN
    SELECT id INTO v_buyer FROM profiles
    WHERE regexp_replace(telefone,'\D','','g') = regexp_replace(NEW.cliente_telefone,'\D','','g')
    LIMIT 1;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.pontos_usados,0) <= 0 THEN
      RETURN NEW;
    END IF;
    NEW.desconto := ROUND(NEW.pontos_usados * v_val, 2);
    NEW.total    := GREATEST(0, ROUND(NEW.subtotal + COALESCE(NEW.taxa_entrega,0) - NEW.desconto, 2));

    IF NEW.forma_pagamento <> 'pix' THEN
      IF v_buyer IS NULL THEN
        RAISE EXCEPTION 'Não foi possível identificar o cliente para usar os pontos.';
      END IF;
      SELECT COALESCE(pontos,0) INTO v_disp FROM saldo_pontos WHERE profile_id = v_buyer;
      IF COALESCE(v_disp,0) < NEW.pontos_usados THEN
        RAISE EXCEPTION 'Saldo de pontos insuficiente.';
      END IF;
      UPDATE saldo_pontos
         SET pontos            = pontos - NEW.pontos_usados,
             pontos_resgatados = COALESCE(pontos_resgatados,0) + NEW.pontos_usados,
             updated_at        = now()
       WHERE profile_id = v_buyer;
      NEW.pontos_debitados := true;
    ELSE
      NEW.pontos_debitados := false;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.pontos_usados,0) > 0
       AND NOT COALESCE(OLD.pontos_debitados,false)
       AND NEW.pix_status = 'pago' AND COALESCE(OLD.pix_status,'') <> 'pago' THEN
      IF v_buyer IS NOT NULL THEN
        SELECT COALESCE(pontos,0) INTO v_disp FROM saldo_pontos WHERE profile_id = v_buyer;
        v_ded := LEAST(COALESCE(v_disp,0), NEW.pontos_usados);
        IF v_ded > 0 THEN
          UPDATE saldo_pontos
             SET pontos            = pontos - v_ded,
                 pontos_resgatados = COALESCE(pontos_resgatados,0) + v_ded,
                 updated_at        = now()
           WHERE profile_id = v_buyer;
        END IF;
        NEW.pontos_debitados := true;
      END IF;
    END IF;

    IF NEW.status = 'cancelado' AND OLD.status <> 'cancelado'
       AND COALESCE(OLD.pontos_debitados,false) AND COALESCE(NEW.pontos_usados,0) > 0 THEN
      IF v_buyer IS NOT NULL THEN
        UPDATE saldo_pontos
           SET pontos            = pontos + NEW.pontos_usados,
               pontos_resgatados = GREATEST(0, COALESCE(pontos_resgatados,0) - NEW.pontos_usados),
               updated_at        = now()
         WHERE profile_id = v_buyer;
      END IF;
      NEW.pontos_debitados := false;
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_resgate_pontos_pedido ON pedidos_delivery;
CREATE TRIGGER trg_resgate_pontos_pedido
  BEFORE INSERT OR UPDATE ON pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION fn_resgate_pontos_pedido();
