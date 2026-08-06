-- 0146_cancelar_venda_fiado.sql
-- Apagar um fiado lançado errado, sem precisar chamar o suporte.
--
-- Caso real (Estação, 06/08/2026): a atendente salvou a conta antes de terminar o
-- pedido, ficou um fiado de R$ 4,00 que não existiu, e ela refez a conta certa.
-- O R$ 4,00 ficou pendurado no nome do cliente pra sempre: na tela do fiado só dá
-- pra RECEBER, não dá pra dizer "isso aí não aconteceu". Teve que apagar no banco.
--
-- Agora o ADM apaga pela própria tela do fiado. Regras da função:
--   • só ADM (garçom vê a lista do fiado pelo Salão, mas não apaga dívida de ninguém)
--   • só venda fiada — venda paga na hora não se apaga por aqui (mexeria no caixa)
--   • se já teve recebimento lançado em cima dela, recusa: primeiro acerta o
--     recebimento, senão o dinheiro que entrou ficaria órfão
--   • a comanda que gerou a venda também vira 'cancelada', pra conta não continuar
--     aparecendo no histórico do salão como se tivesse valido
--
-- Cancela (status='cancelado'), não deleta: quem apagou e o que era continua no
-- banco, e a view clientes_saldo_fiado já ignora venda cancelada.

CREATE OR REPLACE FUNCTION public.cancelar_venda_fiado(p_venda_id uuid, p_motivo text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp    uuid := current_empresa_id();
  v_perfil text;
  v_venda  vendas%ROWTYPE;
  v_pago   numeric;
BEGIN
  SELECT perfil INTO v_perfil FROM profiles WHERE id = auth.uid();
  IF COALESCE(v_perfil, '') NOT IN ('admin', 'super_admin') THEN
    RAISE EXCEPTION 'Só o administrador pode apagar um fiado.';
  END IF;

  SELECT * INTO v_venda FROM vendas WHERE id = p_venda_id AND empresa_id = v_emp;
  IF v_venda.id IS NULL THEN RAISE EXCEPTION 'Venda não encontrada.'; END IF;
  IF v_venda.status = 'cancelado' THEN RETURN; END IF;

  IF v_venda.forma_pagamento = 'a_vista' THEN
    RAISE EXCEPTION 'Essa venda foi paga na hora, não é fiado — não dá pra apagar por aqui.';
  END IF;

  SELECT COALESCE(SUM(valor), 0) INTO v_pago FROM pagamentos WHERE venda_id = p_venda_id;
  IF v_pago > 0 THEN
    RAISE EXCEPTION 'Essa dívida já teve R$ % recebido. Acerte o recebimento antes de apagar.',
      TO_CHAR(v_pago, 'FM999999990.00');
  END IF;

  UPDATE vendas
     SET status = 'cancelado',
         observacoes = COALESCE(observacoes, '') || ' · APAGADA pelo ADM'
                       || COALESCE(': ' || NULLIF(BTRIM(p_motivo), ''), '')
   WHERE id = p_venda_id;

  -- Comanda que gerou: só cancela se não sobrou nenhuma outra venda viva nela
  -- (conta dividida entre 2 clientes gera 2 vendas — apagar uma não anula a conta).
  IF v_venda.comanda_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM vendas WHERE comanda_id = v_venda.comanda_id AND status <> 'cancelado')
  THEN
    UPDATE comandas SET status = 'cancelada' WHERE id = v_venda.comanda_id AND empresa_id = v_emp;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.cancelar_venda_fiado(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_venda_fiado(uuid, text) TO authenticated;
