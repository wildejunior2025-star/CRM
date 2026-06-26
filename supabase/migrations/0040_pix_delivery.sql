-- =========================================================
-- Venda+ Delivery - Migration 0040
-- Módulo: PIX via WhatsApp (Mercado Pago)
-- =========================================================

-- ---------------------------------------------------------
-- 1. NOVAS COLUNAS EM pedidos_delivery
-- ---------------------------------------------------------
alter table pedidos_delivery
  add column if not exists mp_payment_id       text,
  add column if not exists mp_payment_status   text,
  add column if not exists pix_expira_em       timestamptz;

-- motivo_cancelamento já existe em 0020, IF NOT EXISTS é seguro
alter table pedidos_delivery
  add column if not exists motivo_cancelamento text;

-- ---------------------------------------------------------
-- 2. AJUSTE NA CHECK CONSTRAINT DE pix_status
--    0020 criou: check (pix_status in ('pendente', 'pago', 'expirado'))
--    Precisamos adicionar 'nao_aplicavel' e 'reembolsado'.
--    Dropa a constraint antiga pelo nome gerado pelo Postgres
--    (padrão: <tabela>_<coluna>_check) e recria com todos os valores.
-- ---------------------------------------------------------
alter table pedidos_delivery
  drop constraint if exists pedidos_delivery_pix_status_check;

alter table pedidos_delivery
  alter column pix_status set default 'nao_aplicavel',
  add constraint pedidos_delivery_pix_status_check
    check (pix_status in ('nao_aplicavel', 'pendente', 'pago', 'expirado', 'reembolsado'));

-- Corrige linhas antigas que ficaram com default 'pendente' sem serem PIX
-- (pix_txid nulo = não era PIX, então o status correto é 'nao_aplicavel')
update pedidos_delivery
  set pix_status = 'nao_aplicavel'
  where pix_status = 'pendente'
    and pix_txid is null
    and mp_payment_id is null;

-- ---------------------------------------------------------
-- 3. AJUSTE NA CHECK CONSTRAINT DE status
--    0020 criou sem 'aguardando_pagamento'. Adicionamos aqui.
-- ---------------------------------------------------------
alter table pedidos_delivery
  drop constraint if exists pedidos_delivery_status_check;

alter table pedidos_delivery
  add constraint pedidos_delivery_status_check
    check (status in (
      'aguardando_pagamento',  -- PIX emitido, aguardando confirmação do MP
      'aguardando',            -- recebido, aguardando confirmação da loja
      'confirmado',            -- loja aceitou
      'em_preparo',            -- separação em andamento
      'saiu_entrega',          -- entregador saiu
      'entregue',              -- concluído
      'cancelado'              -- recusado ou cancelado
    ));

-- ---------------------------------------------------------
-- 4. ÍNDICE para o cron localizar PIX expirados rapidamente
-- ---------------------------------------------------------
create index if not exists idx_pedidos_delivery_pix_expira
  on pedidos_delivery(pix_expira_em)
  where status = 'aguardando_pagamento';

-- ---------------------------------------------------------
-- 5. CRON — cancela PIX expirados a cada 2 minutos
--    pg_cron só está disponível no plano Pro do Supabase.
--    Se não estiver disponível, esta seção pode ser ignorada
--    e o cancelamento feito via verificação no webhook do MP.
-- ---------------------------------------------------------
create extension if not exists pg_cron;

-- Remove job anterior se existir (evita duplicata em re-run)
select cron.unschedule('cancelar-pix-expirados')
  where exists (
    select 1 from cron.job where jobname = 'cancelar-pix-expirados'
  );

select cron.schedule(
  'cancelar-pix-expirados',
  '*/2 * * * *',
  $$
    UPDATE pedidos_delivery
    SET status = 'cancelado',
        motivo_cancelamento = 'PIX expirado — tempo limite atingido'
    WHERE status = 'aguardando_pagamento'
      AND pix_expira_em IS NOT NULL
      AND pix_expira_em < NOW()
  $$
);
