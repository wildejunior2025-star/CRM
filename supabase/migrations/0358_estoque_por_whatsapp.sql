-- 0358 — ENTRADA DE ESTOQUE PELO WHATSAPP (grupo)
--
-- O lojista cria um grupo com o número da loja dentro, escreve "ativar estoque"
-- nele, e dali em diante o que for dito/enviado no grupo (texto, áudio, foto ou
-- PDF da nota) vira entrada de estoque — depois de um SIM dele. O atendimento
-- no privado continua exatamente como era.
--
-- estoque_grupo_jid  : o grupo escolhido (xxxx@g.us). NULL = recurso desligado.
-- estoque_whatsapp   : a compra que o robô entendeu e está esperando o SIM
--                      (status 'pendente'), o que já foi lançado ('lancado',
--                      guarda os ids dos movimentos pra DESFAZER) ou cancelado.

alter table whatsapp_config
  add column if not exists estoque_grupo_jid text;

create table if not exists estoque_whatsapp (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  grupo_jid   text not null,
  status      text not null default 'pendente' check (status in ('pendente','lancado','cancelado')),
  itens       jsonb not null default '[]'::jsonb,   -- [{tipo,id,nome,quantidade,custo_unit}]
  nao_achados jsonb not null default '[]'::jsonb,   -- o que a IA leu e não existe no cadastro
  origem      text,                                 -- texto | audio | foto | pdf
  mov_produtos jsonb,                               -- ids em estoque_movimentos (pro desfazer)
  mov_materias jsonb,                               -- ids em materia_prima_movimentos
  created_at  timestamptz not null default now(),
  lancado_em  timestamptz
);

create index if not exists idx_estoque_whatsapp_grupo
  on estoque_whatsapp (empresa_id, grupo_jid, created_at desc);

-- Só o robô (service_role) mexe; a tabela não é lida pelo front.
alter table estoque_whatsapp enable row level security;
