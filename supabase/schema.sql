-- =========================================================
-- CRM Depósito de Bebidas - Schema inicial
-- Módulos: Clientes, Produtos, Estoque, Vasilhame (cascos)
-- =========================================================

-- ---------------------------------------------------------
-- CLIENTES (mercadinhos, bares, etc.)
-- ---------------------------------------------------------
create table if not exists clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  tipo text not null default 'mercadinho', -- mercadinho, bar, restaurante, distribuidor...
  cnpj_cpf text,
  telefone text,
  endereco text,
  bairro text,
  cidade text,
  dia_visita text, -- segunda, terca, quarta...
  condicao_pagamento text not null default 'a_vista', -- a_vista, fiado, boleto_7d, boleto_14d...
  limite_credito numeric(12,2) not null default 0,
  ativo boolean not null default true,
  observacoes text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- PRODUTOS
-- ---------------------------------------------------------
create table if not exists produtos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  categoria text not null default 'outros', -- cerveja, refrigerante, agua, energetico, destilado, outros
  embalagem text not null default 'unidade', -- unidade, lata, garrafa, caixa, fardo
  unidades_por_caixa integer not null default 1,
  controla_casco boolean not null default false, -- exige devolução de vasilhame
  preco_custo numeric(12,2) not null default 0,
  preco_venda numeric(12,2) not null default 0,
  estoque_minimo numeric(12,2) not null default 0,
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- MOVIMENTOS DE ESTOQUE
-- ---------------------------------------------------------
create table if not exists estoque_movimentos (
  id uuid primary key default gen_random_uuid(),
  produto_id uuid not null references produtos(id) on delete cascade,
  tipo text not null, -- entrada, saida, ajuste
  quantidade numeric(12,2) not null,
  motivo text, -- compra, venda, perda, devolucao, ajuste_inventario
  observacao text,
  created_at timestamptz not null default now()
);

create index if not exists idx_estoque_movimentos_produto on estoque_movimentos(produto_id);

-- View com saldo atual de estoque por produto
create or replace view estoque_saldo as
select
  p.id as produto_id,
  p.nome,
  p.categoria,
  p.estoque_minimo,
  coalesce(sum(
    case
      when m.tipo = 'entrada' then m.quantidade
      when m.tipo = 'saida' then -m.quantidade
      when m.tipo = 'ajuste' then m.quantidade
      else 0
    end
  ), 0) as quantidade_atual
from produtos p
left join estoque_movimentos m on m.produto_id = p.id
group by p.id, p.nome, p.categoria, p.estoque_minimo;

-- ---------------------------------------------------------
-- VASILHAME / CASCO RETORNÁVEL (saldo por cliente)
-- ---------------------------------------------------------
create table if not exists casco_movimentos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  produto_id uuid not null references produtos(id) on delete cascade,
  tipo text not null, -- entrega (saiu casco cheio para o cliente), devolucao (cliente devolveu casco vazio)
  quantidade numeric(12,2) not null,
  observacao text,
  created_at timestamptz not null default now()
);

create index if not exists idx_casco_movimentos_cliente on casco_movimentos(cliente_id);

-- View com saldo de cascos pendentes por cliente/produto
-- saldo positivo = cliente está com cascos do depósito (precisa devolver)
create or replace view casco_saldo as
select
  c.cliente_id,
  cl.nome as cliente_nome,
  c.produto_id,
  p.nome as produto_nome,
  coalesce(sum(
    case
      when c.tipo = 'entrega' then c.quantidade
      when c.tipo = 'devolucao' then -c.quantidade
      else 0
    end
  ), 0) as saldo_cascos
from casco_movimentos c
join clientes cl on cl.id = c.cliente_id
join produtos p on p.id = c.produto_id
group by c.cliente_id, cl.nome, c.produto_id, p.nome;

-- ---------------------------------------------------------
-- RLS (ajuste conforme autenticação do projeto)
-- ---------------------------------------------------------
alter table clientes enable row level security;
alter table produtos enable row level security;
alter table estoque_movimentos enable row level security;
alter table casco_movimentos enable row level security;

create policy "Usuários autenticados podem tudo - clientes"
  on clientes for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create policy "Usuários autenticados podem tudo - produtos"
  on produtos for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create policy "Usuários autenticados podem tudo - estoque_movimentos"
  on estoque_movimentos for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

create policy "Usuários autenticados podem tudo - casco_movimentos"
  on casco_movimentos for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
