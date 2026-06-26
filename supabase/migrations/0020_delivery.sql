-- =========================================================
-- Venda+ Delivery - Migration 0020
-- Módulo: Delivery público (pedidos sem login, multi-tenant)
-- =========================================================

-- ---------------------------------------------------------
-- 1. CAMPOS DE DELIVERY EM EMPRESAS
-- ---------------------------------------------------------
alter table empresas
  add column if not exists aceita_delivery      boolean         not null default false,
  add column if not exists taxa_entrega         numeric(10,2)   not null default 0,
  add column if not exists tempo_entrega_min    int             not null default 30,
  add column if not exists tempo_entrega_max    int             not null default 60,
  add column if not exists endereco             text,
  add column if not exists cidade               text,
  add column if not exists estado               text,           -- sigla UF, ex: 'RN'
  add column if not exists categoria_delivery   text,           -- 'mercado', 'bebidas', 'farmácia', 'geral', etc.
  add column if not exists horario_abertura     time,
  add column if not exists horario_fechamento   time,
  -- delivery_ativo permite que a loja feche temporariamente sem desativar o delivery
  add column if not exists delivery_ativo       boolean         not null default false;

-- ---------------------------------------------------------
-- 2. CAMPO DE VISIBILIDADE EM PRODUTOS
-- ---------------------------------------------------------
alter table produtos
  add column if not exists disponivel_delivery  boolean         not null default true;

-- ---------------------------------------------------------
-- 3. TABELA PEDIDOS_DELIVERY
-- ---------------------------------------------------------
create table if not exists pedidos_delivery (
  id                    uuid            primary key default gen_random_uuid(),
  empresa_id            uuid            not null references empresas(id),

  -- Dados do consumidor (sem exigir cadastro)
  cliente_id            uuid            references clientes(id) on delete set null,
  cliente_nome          text            not null,
  cliente_telefone      text            not null,

  -- Endereço de entrega
  endereco_rua          text            not null,
  endereco_numero       text,
  endereco_complemento  text,
  endereco_bairro       text,
  endereco_cidade       text            not null,

  -- Itens desnormalizados em jsonb para simplicidade e snapshot de preços
  -- Formato: [{produto_id, nome, quantidade, preco_unitario, subtotal}]
  itens                 jsonb           not null,

  -- Valores
  subtotal              numeric(12,2)   not null,
  taxa_entrega          numeric(12,2)   not null default 0,
  total                 numeric(12,2)   not null,

  -- Pagamento
  forma_pagamento       text            not null
    check (forma_pagamento in ('pix', 'dinheiro')),
  -- Preenchido quando forma_pagamento = 'dinheiro' e o cliente precisa de troco
  troco_para            numeric(12,2),

  -- Dados do Pix (preenchidos pela edge function Mercado Pago)
  pix_txid              text,
  pix_qrcode            text,
  pix_copia_cola        text,
  pix_status            text            not null default 'pendente'
    check (pix_status in ('pendente', 'pago', 'expirado')),

  -- Ciclo de vida do pedido
  status                text            not null default 'aguardando'
    check (status in (
      'aguardando',     -- recebido, aguardando confirmação da loja
      'confirmado',     -- loja aceitou
      'em_preparo',     -- cozinha/separação em andamento
      'saiu_entrega',   -- entregador saiu
      'entregue',       -- concluído
      'cancelado'       -- recusado ou cancelado após confirmação
    )),

  observacoes           text,
  motivo_cancelamento   text,           -- preenchido pela loja ao cancelar

  created_at            timestamptz     not null default now(),
  updated_at            timestamptz     not null default now()
);

-- ---------------------------------------------------------
-- 4. TRIGGER: updated_at automático
-- ---------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Idempotência: recria o trigger sem erro se já existir
drop trigger if exists trg_pedidos_delivery_updated_at on pedidos_delivery;
create trigger trg_pedidos_delivery_updated_at
  before update on pedidos_delivery
  for each row execute function set_updated_at();

-- ---------------------------------------------------------
-- 5. ÍNDICES
-- ---------------------------------------------------------
create index if not exists idx_pedidos_delivery_empresa    on pedidos_delivery(empresa_id);
create index if not exists idx_pedidos_delivery_status     on pedidos_delivery(status);
create index if not exists idx_pedidos_delivery_created_at on pedidos_delivery(created_at desc);
-- pix_txid é pesquisado pelo webhook do Mercado Pago para localizar o pedido
create index if not exists idx_pedidos_delivery_pix_txid   on pedidos_delivery(pix_txid)
  where pix_txid is not null;

-- ---------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------
alter table pedidos_delivery enable row level security;

-- Admin da própria loja gerencia todos os pedidos da empresa
create policy "Admin gerencia pedidos da propria empresa"
  on pedidos_delivery for all
  using (
    current_perfil() = 'admin'
    and empresa_id = current_empresa_id()
  )
  with check (
    current_perfil() = 'admin'
    and empresa_id = current_empresa_id()
  );

-- Super admin vê e gerencia tudo (suporte / painel central)
create policy "Super admin gerencia todos os pedidos delivery"
  on pedidos_delivery for all
  using  (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');

-- Anônimo pode criar pedido (checkout público sem login)
-- A validação de empresa ativa e delivery_ativo é responsabilidade da edge function / UI;
-- aqui apenas garantimos que o INSERT chegue ao banco sem autenticação.
create policy "Anon pode criar pedido delivery"
  on pedidos_delivery for insert
  to anon
  with check (true);

-- Anônimo pode consultar o próprio pedido pelo id (link de acompanhamento)
-- A consulta pública usa service_role na edge function; esta policy cobre acesso direto via anon key.
create policy "Anon consulta pedido pelo id"
  on pedidos_delivery for select
  to anon
  using (true);

-- ---------------------------------------------------------
-- 7. GRANTS
-- ---------------------------------------------------------
-- anon precisa de INSERT e SELECT para o fluxo de pedido sem login
grant insert, select on pedidos_delivery to anon;

-- authenticated herda o que o RLS já restringe por perfil
grant select, insert, update on pedidos_delivery to authenticated;

-- Empresas: anon precisa ler dados da loja (nome, taxa_entrega, delivery_ativo, etc.)
-- para montar o cardápio público antes de qualquer login.
-- A policy "Qualquer autenticado ve empresas ativas" (0013) já cobre authenticated;
-- aqui abrimos só SELECT para anon nas empresas com delivery ativo.
drop policy if exists "Anon ve empresas com delivery ativo" on empresas;
create policy "Anon ve empresas com delivery ativo"
  on empresas for select
  to anon
  using (
    status in ('trial', 'ativo', 'atrasado')
    and aceita_delivery = true
  );

-- Produtos: anon precisa ver o cardápio (produtos disponíveis no delivery)
drop policy if exists "Anon ve produtos disponivel delivery" on produtos;
create policy "Anon ve produtos disponivel delivery"
  on produtos for select
  to anon
  using (
    ativo = true
    and disponivel_delivery = true
  );

grant select on empresas to anon;
grant select on produtos  to anon;
