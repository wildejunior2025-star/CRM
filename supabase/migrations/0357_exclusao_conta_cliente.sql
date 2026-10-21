-- ============================================================================
-- 0357 — Cliente exclui a própria conta pelo app (exigência da Apple, 5.1.1)
--
-- Decisão do dono (21/10/2026): apaga tudo, mas com 30 dias de carência. Nesse
-- prazo o cliente entra de novo e cancela. Passou dos 30 dias, já era:
--   - some o login (auth.users), o perfil, pontos, cashback e a rede de indicação
--   - o cadastro dele em CADA loja e os pedidos antigos viram "Cliente excluído",
--     sem nome, telefone, e-mail, CPF nem endereço. Os valores ficam, pra não
--     furar o caixa, o fiado e o histórico de vendas das lojas.
--
-- Só vale pra perfil 'cliente'. Dono, garçom, entregador etc. não se autoexcluem
-- por aqui (derrubaria a loja sem querer) — esses falam com a FWC.
-- ============================================================================

create table if not exists public.contas_exclusao (
  user_id      uuid primary key,
  pedido_em    timestamptz not null default now(),
  apagar_em    timestamptz not null default now() + interval '30 days',
  cancelado_em timestamptz,
  concluido_em timestamptz
);

alter table public.contas_exclusao enable row level security;

-- O cliente só enxerga o próprio pedido de exclusão.
drop policy if exists contas_exclusao_ler_proprio on public.contas_exclusao;
create policy contas_exclusao_ler_proprio on public.contas_exclusao
  for select using (user_id = auth.uid());

-- ── Pedir ────────────────────────────────────────────────────────────────────
create or replace function public.pedir_exclusao_conta()
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_perfil text;
  v_quando timestamptz;
begin
  if v_uid is null then raise exception 'Entre na sua conta pra excluir.'; end if;
  select perfil into v_perfil from profiles where id = v_uid;
  if coalesce(v_perfil, 'cliente') <> 'cliente' then
    raise exception 'Conta de equipe de loja não se exclui por aqui. Fale com a FWC pelo WhatsApp (84) 99912-0349.';
  end if;

  insert into contas_exclusao (user_id) values (v_uid)
  on conflict (user_id) do update
    set pedido_em = now(), apagar_em = now() + interval '30 days',
        cancelado_em = null, concluido_em = null
  returning apagar_em into v_quando;
  return v_quando;
end $$;

-- ── Cancelar (dentro dos 30 dias) ────────────────────────────────────────────
create or replace function public.cancelar_exclusao_conta()
returns void
language plpgsql security definer set search_path = public as $$
begin
  update contas_exclusao set cancelado_em = now()
   where user_id = auth.uid() and cancelado_em is null and concluido_em is null;
end $$;

-- ── Apagar de vez (um usuário) ───────────────────────────────────────────────
create or replace function public.executar_exclusao_conta(p_uid uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_perfil text;
  v_clientes uuid[];
begin
  select perfil into v_perfil from profiles where id = p_uid;
  if coalesce(v_perfil, 'cliente') <> 'cliente' then
    raise exception 'executar_exclusao_conta: % não é cliente', p_uid;
  end if;

  select coalesce(array_agg(id), '{}') into v_clientes from clientes where user_id = p_uid;

  -- Pedidos: ficam (caixa/fiscal), sem nada que identifique a pessoa.
  update pedidos_delivery
     set user_id = null, cliente_nome = 'Cliente excluído', cliente_telefone = '',
         endereco_rua = null, endereco_numero = null, endereco_complemento = null,
         endereco_bairro = null, endereco_cep = null,
         endereco_lat = null, endereco_lng = null
   where user_id = p_uid or cliente_id = any(v_clientes);

  -- Cadastro em cada loja: fica a linha (fiado/vendas apontam pra ela), sem dados pessoais.
  update clientes
     set user_id = null, nome = 'Cliente excluído', telefone = null,
         email = null, cnpj_cpf = null, endereco = null, numero = null, complemento = null,
         bairro = null, cidade = null, estado = null, cep = null,
         endereco_lat = null, endereco_lng = null, endereco_pin_ref = null,
         endereco_pin_manual = false, endereco_pin_em = null, endereco_pin_origem = null,
         observacoes = null, senha_hash = null, token = null,
         aceita_campanha = false, ativo = false
   where id = any(v_clientes);

  -- O que aponta pro perfil sem cascata.
  update profiles set indicado_por = null where indicado_por = p_uid;
  delete from comissoes_indicacao where beneficiario_id = p_uid or comprador_id = p_uid;
  delete from resgates_pontos where profile_id = p_uid;
  delete from cashback_transacoes where profile_id = p_uid;

  -- Login: leva junto o perfil (cascata) e o que pendura nele.
  delete from auth.users where id = p_uid;

  update contas_exclusao set concluido_em = now() where user_id = p_uid;
end $$;

-- ── Varredura diária ─────────────────────────────────────────────────────────
create or replace function public.executar_exclusoes_vencidas()
returns int
language plpgsql security definer set search_path = public as $$
declare
  r record;
  n int := 0;
begin
  for r in select user_id from contas_exclusao
            where apagar_em <= now() and cancelado_em is null and concluido_em is null
  loop
    begin
      perform executar_exclusao_conta(r.user_id);
      n := n + 1;
    exception when others then
      raise warning 'exclusao de % falhou: %', r.user_id, sqlerrm;
    end;
  end loop;
  return n;
end $$;

revoke all on function public.executar_exclusao_conta(uuid) from public, anon, authenticated;
revoke all on function public.executar_exclusoes_vencidas() from public, anon, authenticated;
grant execute on function public.pedir_exclusao_conta() to authenticated;
grant execute on function public.cancelar_exclusao_conta() to authenticated;

select cron.unschedule('exclusao-contas')
 where exists (select 1 from cron.job where jobname = 'exclusao-contas');
select cron.schedule('exclusao-contas', '30 6 * * *', $$select public.executar_exclusoes_vencidas()$$);
