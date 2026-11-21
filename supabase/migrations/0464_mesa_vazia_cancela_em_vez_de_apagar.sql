-- 0464 — Mesa vazia nao e mais APAGADA: fica cancelada, com historico (Saidera, 21/11/2026)
--
-- Saidera, mesa 16: a mesa estava aberta, o cliente pediu a pre-conta e a comanda tinha sumido do sistema inteiro
-- (a mesma coisa ja tinha acontecido outro dia). Nao sobrou rastro: o unico caminho que apaga comanda
-- (apagar_comanda_vazia, mig 0337, chamado ao sair da tela de uma mesa que o banco ve sem itens) faz DELETE, e nao
-- da pra saber nem quem saiu da mesa nem quando.
--
-- Agora, em MESA, a comanda vazia vira 'cancelada' em vez de ser apagada: some da tela e libera a mesa do mesmo
-- jeito, nao entra no caixa (nao tem venda), e o gatilho log_comanda_cancelada grava em comanda_eventos QUEM
-- cancelou, QUANDO e que estava vazia. Fica no historico pra sempre — comanda vazia nao custa nada guardar.
--
-- BALCAO continua sendo apagada de verdade: o numero da comanda de balcao e unico por dia
-- (uniq_comanda_balcao_numero) e uma cancelada seguraria o numero.

create or replace function public.apagar_comanda_vazia(p_comanda uuid)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_comanda comandas%rowtype;
  v_itens int;
begin
  select * into v_comanda from comandas where id = p_comanda;
  if v_comanda is null then return false; end if;

  if v_comanda.empresa_id <> current_empresa_id() then
    raise exception 'Comanda de outra loja';
  end if;

  -- Só comanda ABERTA. Fechada vira venda; cancelada já é registro.
  if v_comanda.status <> 'aberta' then return false; end if;

  select count(*) into v_itens from comanda_itens where comanda_id = p_comanda;
  if v_itens > 0 then
    return false;   -- tem pedido: fica de pé, mesmo que a tela ache que não
  end if;

  if v_comanda.tipo = 'balcao' then
    delete from comandas where id = p_comanda;
  else
    -- Cancela (e o gatilho registra quem, quando e "Comanda vazia").
    update comandas set status = 'cancelada' where id = p_comanda;
  end if;

  if v_comanda.mesa_id is not null then
    update mesas set status = 'livre' where id = v_comanda.mesa_id;
  end if;
  return true;
end $$;

comment on function public.apagar_comanda_vazia(uuid) is
  'Desocupa comanda ABERTA e sem item. Mesa: vira cancelada (fica no historico, com quem/quando em comanda_eventos). Balcao: apaga de verdade (numero unico por dia). Devolve true se desocupou.';
