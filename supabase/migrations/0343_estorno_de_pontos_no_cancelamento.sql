-- Pedido cancelado DEPOIS de entregue devolve os pontos (18/10/2026).
--
-- Os pontos do app (cashback da plataforma + bônus de indicação) nascem quando o pedido
-- vira 'entregue' (processar_cashback_pedido). Cancelar depois não tirava nada: a loja
-- cancelava e o cliente e a rede dele ficavam com pontos de uma compra que não existe.
-- Foi o que apareceu no teste do pedido #31 do Zebu: cancelado, e 13 pontos ainda lá.
--
-- Estorno: a transação vira 'estornado' (o status já existia e ninguém usava), o comprador
-- perde os pontos, a rede perde o bônus e o acumulado que ganhou por causa dessa compra.
-- Comissão de rede só aceita 'pendente'/'pago': a pendente é apagada (a paga fica).
-- Idempotente: só mexe em transação 'confirmado'.

create or replace function public.estornar_cashback_pedido(p_pedido uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t          record;
  c          record;
  a          record;
  v_acum_pct numeric;
  v_spill    integer;
begin
  select coalesce(
           (select valor::numeric from configuracoes_plataforma where chave = 'acumulado_pct_diretos'),
           20)
    into v_acum_pct;

  for t in
    select * from cashback_transacoes where venda_id = p_pedido and status = 'confirmado'
  loop
    update cashback_transacoes set status = 'estornado' where id = t.id;

    -- Comprador: tira do disponível e do acumulado (foi assim que entrou). Nunca fica negativo.
    update saldo_pontos
       set pontos            = greatest(0, pontos - t.pontos),
           pontos_acumulados = greatest(0, pontos_acumulados - t.pontos),
           updated_at        = now()
     where profile_id = t.profile_id;

    -- Quem está acima dele na rede ganhou um pedaço do acumulado por esta compra.
    v_spill := round(t.pontos * v_acum_pct / 100.0);
    if v_spill > 0 then
      for a in
        select distinct ancestor_id from indicacao_arvore
         where descendant_id = t.profile_id and depth >= 1
      loop
        update saldo_pontos
           set pontos_acumulados = greatest(0, pontos_acumulados - v_spill),
               updated_at        = now()
         where profile_id = a.ancestor_id;
      end loop;
    end if;
  end loop;

  -- Bônus de indicação N1–N5 desta venda que ainda não foi pago.
  for c in
    select * from comissoes_indicacao where venda_id = p_pedido and status = 'pendente'
  loop
    update saldo_pontos
       set pontos     = greatest(0, pontos - coalesce(c.pontos, 0)),
           updated_at = now()
     where profile_id = c.beneficiario_id;
    delete from comissoes_indicacao where id = c.id;
  end loop;
end;
$$;

revoke execute on function public.estornar_cashback_pedido(uuid) from public, anon, authenticated;

create or replace function public.trg_estorna_cashback_cancelamento()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.status = 'cancelado' and OLD.status is distinct from 'cancelado' then
    perform public.estornar_cashback_pedido(NEW.id);
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_estorna_cashback on public.pedidos_delivery;
create trigger trg_estorna_cashback
  after update of status on public.pedidos_delivery
  for each row execute function public.trg_estorna_cashback_cancelamento();

-- O pedido #31 do Zebu (teste) já estava cancelado quando isto nasceu: estorna na mão.
select public.estornar_cashback_pedido('33f6ef33-b625-4313-a056-bd7a47f8b037');
