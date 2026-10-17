-- COMANDA COM ITEM NÃO PODE SER APAGADA (17/10/2026)
--
-- O Braseiro, mesa 4, 19:12: o pedido foi lançado, SAIU NA COZINHA e sumiu da
-- tela. Não sobrou nada no banco — nem a comanda, nem os itens.
--
-- O caminho: `sairDaMesa()` apaga a comanda quando ela está vazia, pra "olhar"
-- uma mesa não deixar ela ocupada com R$ 0,00. Mas ele decide isso pelo
-- ESTADO DA TELA, e a tela fica atrasada de propósito: lançar o item IMPRIME
-- antes de recarregar a lista, e a impressão é esperada (`await`) até a
-- impressora responder. No Braseiro ela é de rede (print-agent, TCP/IP 9100),
-- então se o agente estiver lento ou fora do ar essa espera vai até o timeout.
-- Nessa janela a comanda já tem item no banco e ainda parece vazia na tela.
-- Quem saísse da mesa ali apagava o pedido inteiro — e `comanda_itens` é
-- ON DELETE CASCADE, então não fica rastro nenhum.
--
-- A trava fica AQUI e não só na tela: o estado da tela é justamente o que
-- estava errado. Uma checagem em JavaScript continuaria sendo um palpite sobre
-- o banco; isto é o banco respondendo.
--
-- Por que função e não gatilho de BEFORE DELETE: apagar uma loja inteira
-- (mig 0265) cascateia pelas comandas, e um gatilho que levanta exceção
-- travaria a exclusão da empresa. Aqui a trava fica no caminho que a tela usa.
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

  -- Só comanda ABERTA. Fechada vira venda; cancelada é registro de que algo
  -- aconteceu ali, e os dois têm que sobreviver pro histórico.
  if v_comanda.status <> 'aberta' then return false; end if;

  select count(*) into v_itens from comanda_itens where comanda_id = p_comanda;
  if v_itens > 0 then
    return false;   -- tem pedido: fica de pé, mesmo que a tela ache que não
  end if;

  delete from comandas where id = p_comanda;
  if v_comanda.mesa_id is not null then
    update mesas set status = 'livre' where id = v_comanda.mesa_id;
  end if;
  return true;
end $$;

comment on function public.apagar_comanda_vazia(uuid) is
  'Apaga a comanda SO se ela estiver aberta e sem nenhum item. Devolve true se apagou. Existe porque a tela decidia isso por estado atrasado e apagava pedido ja lancado (Braseiro, mesa 4, 17/10).';
