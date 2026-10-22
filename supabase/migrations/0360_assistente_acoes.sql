-- 0360 — AÇÕES QUE O ASSISTENTE PROPÕE NO WHATSAPP (e só executa depois do SIM)
--
-- O assistente da loja ganhou ferramentas de escrita (cadastrar produto, mudar preço,
-- taxa de entrega, pedido mínimo). Ele NUNCA grava direto: grava aqui uma PROPOSTA,
-- mostra o resumo no grupo e espera o dono responder SIM. Quem executa é a função
-- estoque-whatsapp, e guarda em `antes` o que mudou pra o DESFAZER devolver.

create table if not exists assistente_acoes (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  grupo_jid   text not null,
  tipo        text not null check (tipo in ('cadastrar_produto','mudar_preco','taxa_entrega_fixa','pedido_minimo','ajustar_tabela_km')),
  params      jsonb not null default '{}'::jsonb,
  resumo      text not null,
  status      text not null default 'pendente' check (status in ('pendente','executada','cancelada')),
  antes       jsonb,
  created_at  timestamptz not null default now(),
  executada_em timestamptz
);

create index if not exists idx_assistente_acoes_grupo
  on assistente_acoes (empresa_id, grupo_jid, created_at desc);

-- Só o robô (service_role) lê e escreve.
alter table assistente_acoes enable row level security;
