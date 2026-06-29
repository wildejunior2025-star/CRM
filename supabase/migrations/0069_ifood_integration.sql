-- =========================================================
-- Migration 0069 - Integração com o iFood (Merchant/Order API)
-- =========================================================
-- Os pedidos que caem no iFood passam a aparecer no /painel junto com os
-- demais, com origem = 'ifood'. A edge function `ifood-integration` faz o
-- polling de eventos no iFood, busca os detalhes do pedido e grava aqui.
-- Quando o lojista avança o status no painel, a mesma função devolve o
-- status pro iFood (confirmar / despachar / concluir / cancelar).
--
-- Modelo: 1 conjunto de credenciais (app) por empresa. Quando a FWC virar
-- integradora distribuída (1 app p/ vários merchants), trocamos o loop por
-- roteamento via merchant_id — a tabela já guarda merchant_id.
-- =========================================================

-- ---------------------------------------------------------
-- 1. CONFIG DO IFOOD POR EMPRESA
-- ---------------------------------------------------------
create table if not exists ifood_config (
  empresa_id        uuid          primary key references empresas(id) on delete cascade,

  -- Credenciais do app no Portal do Desenvolvedor do iFood
  client_id         text,
  client_secret     text,
  merchant_id       text,                              -- UUID da loja no iFood

  -- 'teste' usa a loja de teste do portal; 'producao' a loja real
  ambiente          text          not null default 'teste'
    check (ambiente in ('teste', 'producao')),

  -- Liga/desliga a integração e o polling automático
  ativo             boolean       not null default false,
  polling_ativo     boolean       not null default true,

  -- Cache do token OAuth (client_credentials) pra não reautenticar a cada poll
  access_token      text,
  token_expira_em   timestamptz,

  -- Telemetria do polling
  ultimo_polling_em timestamptz,
  ultimo_erro       text,

  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

drop trigger if exists trg_ifood_config_updated_at on ifood_config;
create trigger trg_ifood_config_updated_at
  before update on ifood_config
  for each row execute function set_updated_at();

-- ---------------------------------------------------------
-- 2. CAMPOS DO IFOOD EM PEDIDOS_DELIVERY
-- ---------------------------------------------------------
alter table pedidos_delivery
  add column if not exists ifood_order_id   text,   -- id (UUID) do pedido no iFood
  add column if not exists ifood_display_id text,   -- código curto exibido (ex: "1234")
  add column if not exists ifood_status     text;   -- último status conhecido no iFood

-- Mesmo pedido do iFood nunca pode entrar duas vezes
create unique index if not exists uq_pedidos_delivery_ifood_order
  on pedidos_delivery(ifood_order_id)
  where ifood_order_id is not null;

create index if not exists idx_pedidos_delivery_origem
  on pedidos_delivery(origem);

-- ---------------------------------------------------------
-- 3. RELAXA O CHECK DE forma_pagamento
-- ---------------------------------------------------------
-- O iFood traz formas que não existiam no fluxo original (cartão na entrega,
-- pago online no app, vale-refeição, etc.). Ampliamos o domínio permitido.
alter table pedidos_delivery
  drop constraint if exists pedidos_delivery_forma_pagamento_check;
alter table pedidos_delivery
  add constraint pedidos_delivery_forma_pagamento_check
  check (forma_pagamento in (
    'pix', 'dinheiro', 'credito', 'debito', 'cartao', 'online', 'vale', 'outro'
  ));

-- ---------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------
alter table ifood_config enable row level security;

drop policy if exists "Admin gerencia ifood_config da propria empresa" on ifood_config;
create policy "Admin gerencia ifood_config da propria empresa"
  on ifood_config for all
  using (
    current_perfil() = 'admin'
    and empresa_id = current_empresa_id()
  )
  with check (
    current_perfil() = 'admin'
    and empresa_id = current_empresa_id()
  );

drop policy if exists "Super admin gerencia ifood_config" on ifood_config;
create policy "Super admin gerencia ifood_config"
  on ifood_config for all
  using  (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');

grant select, insert, update, delete on ifood_config to authenticated;

-- ---------------------------------------------------------
-- 5. CRON DE POLLING (a cada 30s)
-- ---------------------------------------------------------
-- Chama a edge function ifood-integration no modo poll. A função varre as
-- empresas com ifood_config ativo + polling_ativo, busca eventos e grava os
-- pedidos. iFood recomenda polling a cada 30 segundos.
DO $$ BEGIN
  PERFORM cron.unschedule('ifood-polling');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'ifood-polling',
  '30 seconds',
  $cron$
  SELECT net.http_post(
    url := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/ifood-integration',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"acao": "poll"}'::jsonb
  ) AS request_id
  $cron$
);
