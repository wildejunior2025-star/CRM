-- Checklist de instalação por loja (Super Admin).
--
-- O que ficou de fora do checklist (acesso remoto, impressora, teste...) sempre
-- era descoberto depois, com a loja com problema. Aqui fica o que JÁ foi feito
-- em cada loja, quem marcou e quando — serve pra quem for contratado depois.
--
-- A lista de itens mora no código (src/lib/checklistInstalacao.js): só a marca
-- de "feito" é gravada. Item novo na lista aparece desmarcado em todas as lojas.
create table if not exists public.empresa_checklist (
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  item text not null,
  feito_em timestamptz not null default now(),
  feito_por uuid,
  feito_por_nome text,
  primary key (empresa_id, item)
);

alter table public.empresa_checklist enable row level security;

-- Só o Super Admin lê e escreve. A loja nunca vê.
drop policy if exists "Super admin gerencia checklist de instalacao" on public.empresa_checklist;
create policy "Super admin gerencia checklist de instalacao"
  on public.empresa_checklist for all
  using (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');
