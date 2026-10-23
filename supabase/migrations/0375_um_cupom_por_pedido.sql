-- Um cupom por pedido, nao um por aparelho (23/10/2026)
--
-- POR QUE EXISTE
-- No Agv Grill saiam DOIS cupons identicos de cada pedido do iFood. Nao era
-- pedido duplicado: o #5462 e um so no banco. Era aparelho duplicado.
--
-- O controle de "ja imprimi este pedido" sempre foi LOCAL. O app Impressora
-- FWC guarda num arquivo na maquina dele; o navegador se cala quando acha o
-- app NAQUELE computador (fwcImprimeRef). As duas travas funcionam dentro de
-- um PC e nao enxergam nada fora dele — o desenho supunha uma loja, um PC.
--
-- O Agv tem dois: um com o app e outro so com o gestor aberto, que caiu na
-- impressao pelo navegador. Cada um achou que era o unico e imprimiu. Com tres
-- computadores seriam tres vias, e assim por diante.
--
-- A trava tem que morar onde todos enxergam: aqui.

create table if not exists public.impressao_dono (
  pedido_id  uuid primary key references public.pedidos_delivery(id) on delete cascade,
  empresa_id uuid        not null references public.empresas(id) on delete cascade,
  quem       text        not null default '',   -- so pra investigar depois
  criado_em  timestamptz not null default now()
);

create index if not exists idx_impressao_dono_criado on public.impressao_dono (criado_em);

alter table public.impressao_dono enable row level security;

-- Quem ganhou a vez fica registrado; a loja le e escreve a propria linha.
drop policy if exists "Loja cuida da propria impressao" on public.impressao_dono;
create policy "Loja cuida da propria impressao"
  on public.impressao_dono for all
  using      (empresa_id = (select current_empresa_id()))
  with check (empresa_id = (select current_empresa_id()));

drop policy if exists "Super admin ve as impressoes" on public.impressao_dono;
create policy "Super admin ve as impressoes"
  on public.impressao_dono for all
  using      ((select current_perfil()) = 'super_admin')
  with check ((select current_perfil()) = 'super_admin');

-- ── a vez ───────────────────────────────────────────────────────────────────
-- Devolve TRUE pra UM aparelho so. Os outros levam FALSE e nao imprimem.
--
-- Nao da pra resolver isso no app lendo "ja tem dono?" antes de inserir: dois
-- aparelhos leem "nao tem" no mesmo instante e os dois imprimem. Quem desempata
-- e a chave primaria — o segundo INSERT nao entra, e o FOUND conta a verdade.
create or replace function public.reservar_impressao(p_pedido uuid, p_quem text default '')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid;
begin
  select empresa_id into v_empresa from pedidos_delivery where id = p_pedido;
  if v_empresa is null then return false; end if;

  -- Security definer passa por cima da RLS, entao a conferencia e aqui.
  if v_empresa <> (select current_empresa_id())
     and coalesce((select current_perfil()), '') <> 'super_admin' then
    return false;
  end if;

  insert into impressao_dono (pedido_id, empresa_id, quem)
  values (p_pedido, v_empresa, left(coalesce(p_quem, ''), 60))
  on conflict (pedido_id) do nothing;

  -- Faxina de vez em quando, pra tabela nao virar historico: o que passou de
  -- dois dias nao serve mais (o pedido ja foi entregue havia muito).
  if random() < 0.02 then
    delete from impressao_dono where criado_em < now() - interval '2 days';
  end if;

  return found;
end;
$$;

revoke all on function public.reservar_impressao(uuid, text) from public;
grant execute on function public.reservar_impressao(uuid, text) to authenticated;

comment on function public.reservar_impressao(uuid, text) is
  'Da a vez de imprimir um pedido a UM aparelho so. TRUE = pode imprimir.';
