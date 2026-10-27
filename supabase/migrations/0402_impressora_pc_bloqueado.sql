-- PC barrado numa loja nunca ganha a vez de imprimir (reservar_impressao).
-- Caso Zebu 27/10/2026: um PC de fora (DESKTOP-69VJLGU, com ELGIN USB offline)
-- ficou logado na loja e reservava o pedido ~1s antes do PC da loja, entao o
-- papel ia pra uma impressora morta e nada saia no balcao. A funcao continua
-- SECURITY DEFINER (CREATE OR REPLACE sem isso apagaria o atributo).
create table if not exists public.impressora_pc_bloqueado (
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  pc text not null,
  motivo text,
  criado_em timestamptz not null default now(),
  primary key (empresa_id, pc)
);
alter table public.impressora_pc_bloqueado enable row level security;

-- reservar_impressao: igual a anterior + checagem do PC barrado logo apos a de empresa.
-- (corpo aplicado direto no banco; ver pg_get_functiondef)
-- Para liberar o PC: delete from impressora_pc_bloqueado where pc = 'DESKTOP-69VJLGU';
