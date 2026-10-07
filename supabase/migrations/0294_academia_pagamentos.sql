-- =========================================================
-- Migration 0294 - Academia: histórico de pagamentos
-- =========================================================
-- O botão "Renovar" só empurrava o vencimento e não guardava nada: ninguém
-- sabia quem pagou hoje, quanto entrou no dia nem quem registrou. Agora cada
-- renovação vira um pagamento com valor, forma e autor, e dá pra cancelar
-- (volta o vencimento pro que era antes).
--
-- É também a base do PIX: quando o aluno pagar pelo celular, o pagamento cai
-- aqui sozinho e o vencimento anda sem ninguém clicar.
-- =========================================================

create table if not exists academia_pagamentos (
  id                 uuid primary key default gen_random_uuid(),
  empresa_id         uuid not null references empresas(id) on delete cascade,
  aluno_id           uuid not null references academia_alunos(id) on delete cascade,
  valor              numeric(10,2) not null,
  forma              text not null default 'dinheiro',
  meses              integer not null default 1,
  data               date not null default current_date,
  vencimento_antes   date,
  vencimento_depois  date,
  observacao         text,
  cancelado          boolean not null default false,
  criado_em          timestamptz not null default now(),
  criado_por         uuid references auth.users(id) on delete set null
);

create index if not exists academia_pagamentos_empresa_idx on academia_pagamentos (empresa_id, data desc);
create index if not exists academia_pagamentos_aluno_idx on academia_pagamentos (aluno_id, data desc);

alter table academia_pagamentos enable row level security;

drop policy if exists "academia_pagamentos loja le" on academia_pagamentos;
create policy "academia_pagamentos loja le" on academia_pagamentos
  for select to authenticated using (empresa_id = current_empresa_id());

drop policy if exists "academia_pagamentos loja grava" on academia_pagamentos;
create policy "academia_pagamentos loja grava" on academia_pagamentos
  for insert to authenticated with check (empresa_id = current_empresa_id());

drop policy if exists "academia_pagamentos loja altera" on academia_pagamentos;
create policy "academia_pagamentos loja altera" on academia_pagamentos
  for update to authenticated using (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());

comment on table academia_pagamentos is
  'Mensalidades recebidas na academia: cada "Renovar" grava uma linha com valor, forma e quem registrou (mig 0294).';
