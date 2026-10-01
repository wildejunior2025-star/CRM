-- =========================================================
-- 0290: o auto-concluir de 6h passa a pagar a indicação
-- =========================================================
-- O job `auto-concluir-pedidos-6h` marca 'entregue' com
-- session_replication_role = replica, de propósito: sem isso o cliente
-- receberia "pedido entregue" no WhatsApp horas depois, e o estoque/gatilhos
-- rodariam de novo num pedido que a loja já tratou.
--
-- Só que o replica cala TODOS os gatilhos, inclusive o que paga a indicação
-- (trg_indicacao_pedido_entregue, mig 0176). Na CDBom, que entrega no dia
-- seguinte e deixa quase tudo pro auto-concluir, a indicação nunca pagava:
-- Diego → Júlio ficou pendente com o pedido já entregue (30/09/2026).
--
-- Mantemos o replica e chamamos o indicacao_quitar na mão, só pros pedidos
-- que este job acabou de concluir. Ela já é idempotente (só paga 'pendente').
-- =========================================================

DO $$
DECLARE
  v_job bigint;
BEGIN
  SELECT jobid INTO v_job FROM cron.job WHERE jobname = 'auto-concluir-pedidos-6h';
  IF v_job IS NULL THEN RETURN; END IF;

  PERFORM cron.alter_job(v_job, command := $cmd$
    DO $inner$
    DECLARE
      r record;
    BEGIN
      SET LOCAL session_replication_role = replica;
      FOR r IN
        UPDATE pedidos_delivery
        SET status = 'entregue', updated_at = NOW()
        WHERE status IN ('confirmado','em_preparo','pronto','saiu_entrega')
          AND origem <> 'ifood'
          AND created_at < NOW() - INTERVAL '6 hours'
        RETURNING empresa_id, cliente_id, total
      LOOP
        PERFORM indicacao_quitar(r.empresa_id, r.cliente_id, r.total);
      END LOOP;
    END
    $inner$;
  $cmd$);
END $$;
