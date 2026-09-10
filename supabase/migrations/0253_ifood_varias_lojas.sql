-- =========================================================
-- Migration 0253 - Várias lojas do iFood na mesma empresa
-- =========================================================
-- Tem cliente com mais de uma loja no iFood saindo da MESMA cozinha (marcas
-- diferentes, cardápio quase igual). O iFood não junta essas lojas: o lojista
-- fica pulando de conta pra ver os pedidos. Aqui eles passam a cair todos no
-- mesmo painel.
--
-- Antes: ifood_config tinha empresa_id como primary key -> 1 merchant por
-- empresa. Agora a tabela tem id próprio e aceita N linhas por empresa, uma
-- por loja do iFood. Uma delas é a `principal` (a que responde quando a ação
-- não diz de qual loja se trata — cardápio, por exemplo).
--
-- O cardápio continua sendo tocado no iFood: aqui a briga é só pelos pedidos.
-- =========================================================

-- ---------------------------------------------------------
-- 1. ifood_config passa a aceitar várias lojas por empresa
-- ---------------------------------------------------------
alter table ifood_config add column if not exists id       uuid    not null default gen_random_uuid();
alter table ifood_config add column if not exists apelido  text;      -- "Pastelaria", "Açaí do João"
alter table ifood_config add column if not exists principal boolean not null default false;

-- As que já existem hoje (uma por empresa) viram as principais
update ifood_config set principal = true where principal = false;

alter table ifood_config drop constraint if exists ifood_config_pkey;
alter table ifood_config add  constraint ifood_config_pkey primary key (id);

create index if not exists idx_ifood_config_empresa on ifood_config(empresa_id);

-- Um merchant do iFood não pode estar em duas contas do CRM (pedido cairia
-- duplicado, em painéis diferentes).
create unique index if not exists uq_ifood_config_merchant
  on ifood_config(merchant_id) where merchant_id is not null;

-- Só uma principal por empresa
create unique index if not exists uq_ifood_config_principal
  on ifood_config(empresa_id) where principal;

-- ---------------------------------------------------------
-- 2. O pedido guarda de qual loja do iFood veio
-- ---------------------------------------------------------
-- Sem isso não dá pra devolver confirmar/despachar/cancelar pro merchant certo
-- nem separar o faturamento de cada marca.
alter table pedidos_delivery add column if not exists ifood_merchant_id text;

create index if not exists idx_pedidos_delivery_ifood_merchant
  on pedidos_delivery(ifood_merchant_id) where ifood_merchant_id is not null;

-- Pedidos antigos são todos da única loja que a empresa tinha
update pedidos_delivery p
   set ifood_merchant_id = c.merchant_id
  from ifood_config c
 where c.empresa_id = p.empresa_id
   and c.principal
   and c.merchant_id is not null
   and p.origem = 'ifood'
   and p.ifood_merchant_id is null;
