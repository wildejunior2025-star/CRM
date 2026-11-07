-- Uma PRE-CONTA por pedido, nao uma por aparelho (07/11/2026)
--
-- Restaurante do Irmao: pedindo a pre-conta pelo celular saiam DUAS; pelo PC,
-- uma. O celular nao tem impressora, entao carimba comandas.preconta_pedida_em
-- e QUEM TIRA O PAPEL e o Painel da loja. So que o carimbo chega a TODO Painel
-- aberto (PC, tablet, outra aba), e a trava contra repeticao era local de cada
-- tela — cada uma achou que era a unica e imprimiu. Pelo PC nao havia carimbo:
-- imprimia direto, uma vez.
--
-- Mesma ideia da 0375 (impressao_dono, que e por pedido): a vez mora no banco.
-- A chave e (comanda, carimbo): outro clique em "Pre-conta" gera outro carimbo e
-- sai de novo, que e o que o lojista pede; o MESMO carimbo so sai uma vez.

create table if not exists public.impressao_preconta (
  comanda_id uuid        not null references public.comandas(id) on delete cascade,
  carimbo    timestamptz not null,
  empresa_id uuid        not null references public.empresas(id) on delete cascade,
  quem       text        not null default '',
  criado_em  timestamptz not null default now(),
  primary key (comanda_id, carimbo)
);

alter table public.impressao_preconta enable row level security;

drop policy if exists "Loja cuida da propria preconta" on public.impressao_preconta;
create policy "Loja cuida da propria preconta"
  on public.impressao_preconta for all
  using      (empresa_id = (select current_empresa_id()))
  with check (empresa_id = (select current_empresa_id()));

drop policy if exists "Super admin ve as precontas" on public.impressao_preconta;
create policy "Super admin ve as precontas"
  on public.impressao_preconta for all
  using      ((select current_perfil()) = 'super_admin')
  with check ((select current_perfil()) = 'super_admin');

-- TRUE pra UM aparelho so; os outros levam FALSE e nao imprimem. Quem desempata
-- e a chave primaria, nao um "ja tem dono?" lido antes (dois leriam "nao").
create or replace function public.reservar_preconta(p_comanda uuid, p_carimbo timestamptz, p_quem text default '')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid;
begin
  select empresa_id into v_empresa from comandas where id = p_comanda;
  if v_empresa is null then return false; end if;

  if v_empresa <> (select current_empresa_id())
     and coalesce((select current_perfil()), '') <> 'super_admin' then
    return false;
  end if;

  insert into impressao_preconta (comanda_id, carimbo, empresa_id, quem)
  values (p_comanda, p_carimbo, v_empresa, left(coalesce(p_quem, ''), 60))
  on conflict (comanda_id, carimbo) do nothing;

  if random() < 0.02 then
    delete from impressao_preconta where criado_em < now() - interval '2 days';
  end if;

  return found;
end;
$$;

revoke all on function public.reservar_preconta(uuid, timestamptz, text) from public, anon;
grant execute on function public.reservar_preconta(uuid, timestamptz, text) to authenticated;

comment on function public.reservar_preconta(uuid, timestamptz, text) is
  'Da a vez de imprimir uma pre-conta pedida (comanda + carimbo) a UM aparelho so. TRUE = pode imprimir.';
