-- =========================================================
-- Migration 0103 - NFC-e: cadastro fiscal (Fase 0 + fiscal)
-- =========================================================
-- 100% ADITIVO. Não altera nada que já funciona:
--   * colunas novas com `if not exists` / default seguro
--   * tabelas novas (empresa_fiscal, nfce_notas)
--   * a emissão é SOB DEMANDA e OPT-IN: fica desligada (ativo=false) até a
--     loja preencher os dados e ligar. Nenhum pedido emite nota sozinho.
--
-- Duas coisas aqui:
--   1) Fase 0  — guardar o customer.billingAddress que o iFood passa a mandar
--      em pedidos de RETIRADA a partir de 03/08/2026 (exigência SINIEF 9/26).
--      Campo fiscal, separado do endereço operacional de retirada.
--   2) Cadastro fiscal — dados da loja (IE, regime, CSC) e dos produtos
--      (NCM, CFOP, CSOSN, origem) necessários pra emitir a NFC-e, mais a
--      tabela onde cada nota emitida é registrada.
-- A emissão de verdade (chamar o emissor/SEFAZ) é uma migration/edge à parte.
-- =========================================================

-- ---------------------------------------------------------
-- 1. FASE 0 — endereço fiscal do iFood (retirada)
-- ---------------------------------------------------------
-- NÃO sobrescreve os campos endereco_* do pedido (esses são a operação/rota).
-- billingAddress é SÓ fiscal e fica null até 03/08.
alter table pedidos_delivery
  add column if not exists ifood_billing_address jsonb;

-- ---------------------------------------------------------
-- 2. DADOS FISCAIS DA LOJA (tabela própria, secrets protegidos)
-- ---------------------------------------------------------
-- Guardado FORA de `empresas` de propósito: empresas é lida publicamente na
-- vitrine (loja online). CSC/token não podem vazar. Aqui a RLS é só do dono.
create table if not exists empresa_fiscal (
  empresa_id          uuid        primary key references empresas(id) on delete cascade,

  -- Liga/desliga a emissão de NFC-e pra essa loja. Default: DESLIGADO.
  ativo               boolean     not null default false,

  -- Dados do contribuinte (o CNPJ/razão social já ficam em `empresas`)
  inscricao_estadual  text,
  regime_tributario   text        default 'simples'
    check (regime_tributario in ('simples', 'simples_excesso', 'normal')),

  -- NFC-e (modelo 65): CSC/Token de segurança gerado no portal da SEFAZ do
  -- estado, ID do CSC, série e ambiente. Emitir em homologação primeiro.
  csc                 text,
  csc_id              text,
  serie               integer     not null default 1,
  ambiente            text        not null default 'homologacao'
    check (ambiente in ('homologacao', 'producao')),

  -- Emissor terceirizado (não falamos direto com a SEFAZ). Ex.: plugnotas.
  emissor             text        default 'plugnotas',
  emissor_token       text,       -- api-key do emissor (secret)

  -- Certificado digital A1: referência ao objeto no bucket (não o arquivo).
  certificado_ref     text,
  certificado_validade date,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists trg_empresa_fiscal_updated_at on empresa_fiscal;
create trigger trg_empresa_fiscal_updated_at
  before update on empresa_fiscal
  for each row execute function set_updated_at();

alter table empresa_fiscal enable row level security;

drop policy if exists "Admin gerencia fiscal da propria empresa" on empresa_fiscal;
create policy "Admin gerencia fiscal da propria empresa"
  on empresa_fiscal for all
  using  (current_perfil() = 'admin' and empresa_id = current_empresa_id())
  with check (current_perfil() = 'admin' and empresa_id = current_empresa_id());

drop policy if exists "Super admin gerencia fiscal" on empresa_fiscal;
create policy "Super admin gerencia fiscal"
  on empresa_fiscal for all
  using  (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');

grant select, insert, update, delete on empresa_fiscal to authenticated;

-- ---------------------------------------------------------
-- 3. DADOS FISCAIS POR PRODUTO
-- ---------------------------------------------------------
-- Aditivo. Ficam null até a loja preencher; só usados na hora de emitir.
alter table produtos
  add column if not exists ncm            text,   -- classificação fiscal (8 díg.)
  add column if not exists cfop           text,   -- ex.: 5102 (venda dentro do estado)
  add column if not exists csosn          text,   -- Simples (ex.: 102); CST se normal
  add column if not exists origem         text default '0', -- 0=nacional
  add column if not exists cest           text,   -- opcional (subst. tributária)
  add column if not exists unidade_trib   text default 'UN';

-- ---------------------------------------------------------
-- 4. NOTAS EMITIDAS (uma linha por tentativa de emissão)
-- ---------------------------------------------------------
create table if not exists nfce_notas (
  id            uuid        primary key default gen_random_uuid(),
  empresa_id    uuid        not null references empresas(id) on delete cascade,
  pedido_id     uuid        references pedidos_delivery(id) on delete set null,

  -- rascunho -> processando -> autorizada | rejeitada | cancelada
  status        text        not null default 'rascunho'
    check (status in ('rascunho','processando','autorizada','rejeitada','cancelada')),

  ambiente      text        not null default 'homologacao',
  numero        integer,                 -- número da nota
  serie         integer,
  chave_acesso  text,                    -- 44 dígitos
  protocolo     text,                    -- protocolo de autorização SEFAZ
  emissor_id    text,                    -- id da nota no emissor (plugnotas)
  xml_url       text,
  danfe_url     text,                    -- DANFE-NFCe (cupom) pra imprimir/enviar
  valor_total   numeric,
  motivo_rejeicao text,                  -- msg de erro da SEFAZ/emissor
  emitida_por   uuid        references auth.users(id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_nfce_notas_empresa on nfce_notas(empresa_id);
create index if not exists idx_nfce_notas_pedido  on nfce_notas(pedido_id);

drop trigger if exists trg_nfce_notas_updated_at on nfce_notas;
create trigger trg_nfce_notas_updated_at
  before update on nfce_notas
  for each row execute function set_updated_at();

alter table nfce_notas enable row level security;

drop policy if exists "Empresa ve as proprias notas" on nfce_notas;
create policy "Empresa ve as proprias notas"
  on nfce_notas for all
  using  (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());

drop policy if exists "Super admin ve todas as notas" on nfce_notas;
create policy "Super admin ve todas as notas"
  on nfce_notas for all
  using  (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');

grant select, insert, update, delete on nfce_notas to authenticated;
