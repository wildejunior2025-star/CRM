-- Repasse SEMANAL exato do iFood, lido do PDF de Repasse (Portal do Parceiro).
-- Guarda o "Valor do repasse" e o anúncio já cravados por período de apuração.
create table if not exists public.ifood_repasse_semanal (
  empresa_id         uuid not null references public.empresas(id) on delete cascade,
  periodo_ini        date not null,
  periodo_fim        date,
  previsao_pagamento date,
  situacao           text,       -- 'pago' | 'em aberto'
  vendas             numeric,
  anuncio            numeric,
  valor_repasse      numeric,    -- o "Valor do repasse" exato do PDF
  importado_em       timestamptz not null default now(),
  primary key (empresa_id, periodo_ini)
);
alter table public.ifood_repasse_semanal enable row level security;
create policy "Loja gerencia seu repasse semanal" on public.ifood_repasse_semanal
  for all using (empresa_id = current_empresa_id()) with check (empresa_id = current_empresa_id());
create policy "Super admin repasse semanal" on public.ifood_repasse_semanal
  for all using (current_perfil() = 'super_admin') with check (current_perfil() = 'super_admin');
