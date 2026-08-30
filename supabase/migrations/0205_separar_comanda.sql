-- =========================================================
-- Migration 0205 — Separar a conta de uma pessoa da mesa
-- =========================================================
-- Quatro amigos numa mesa, uma vai embora antes e quer pagar só o que consumiu.
-- Até aqui não havia saída: o "Dividir conta" só libera o recebimento quando as
-- partes cobrem a conta INTEIRA, e aí fecha a mesa toda. Na prática o garçom
-- fazia a conta de cabeça e cobrava por fora, ou a mesa inteira fechava e
-- reabria — perdendo o que já tinha sido lançado.
--
-- Aqui os ITENS dela saem da mesa e viram uma comanda no NOME dela. Ela fecha
-- essa comanda normalmente (venda, estoque, caixa, os 10% sobre o que ela
-- consumiu) e vai embora; a mesa continua com o resto.
--
-- É a mesma peça da comanda por nome que o balcão já usa, e o contrário do
-- mover_comanda (mig 0203): lá a pessoa sai da mesa, aqui saem os itens dela.
--
-- Move numa transação só: se os itens saíssem e a comanda nova falhasse, o
-- consumo sumiria das duas contas.
-- =========================================================

create or replace function separar_comanda(
  p_comanda_id uuid,
  p_itens      uuid[],
  p_nome       text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp    uuid := current_empresa_id();
  v_com    comandas%rowtype;
  v_nova   uuid;
  v_num    integer;
  v_dia    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_qtd    integer;
  v_total  integer;
begin
  if v_emp is null then raise exception 'Empresa não identificada.'; end if;
  if nullif(btrim(coalesce(p_nome, '')), '') is null then
    raise exception 'Escreva o nome de quem vai levar a conta.';
  end if;

  select * into v_com from comandas where id = p_comanda_id and empresa_id = v_emp;
  if v_com.id is null then raise exception 'Comanda não encontrada.'; end if;
  if v_com.status <> 'aberta' then
    raise exception 'Só dá pra separar de uma comanda aberta.';
  end if;

  -- Conta o que foi marcado (e que é mesmo desta comanda) e o que ela tem.
  select count(*) into v_qtd
    from comanda_itens
   where comanda_id = v_com.id and id = any(p_itens);
  select count(*) into v_total from comanda_itens where comanda_id = v_com.id;

  if v_qtd = 0 then raise exception 'Marque pelo menos um item.'; end if;
  -- Levar TUDO não é separar conta, é trocar a comanda de lugar — e deixaria a
  -- mesa ocupada por uma comanda vazia, que ninguém sabe se fecha ou cancela.
  if v_qtd = v_total then
    raise exception 'Isso levaria todos os itens. Para mudar a comanda inteira de lugar, use "Trocar de mesa".';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_emp::text || v_dia::text));
  select coalesce(max(numero_mesa), 0) + 1 into v_num
    from comandas
   where empresa_id = v_emp and tipo = 'balcao' and dia = v_dia;

  insert into comandas (empresa_id, mesa_id, numero_mesa, tipo, nome_cliente, dia,
                        status, garcom_id, num_pessoas, observacoes)
  values (v_emp, null, v_num, 'balcao', btrim(p_nome), v_dia,
          'aberta', coalesce(v_com.garcom_id, auth.uid()), 1,
          'Separada da ' || coalesce('mesa ' || v_com.numero_mesa::text, 'comanda'))
  returning id into v_nova;

  update comanda_itens
     set comanda_id = v_nova
   where comanda_id = v_com.id and id = any(p_itens);

  return jsonb_build_object('ok', true, 'comanda_id', v_nova, 'itens', v_qtd,
                            'rotulo', rotulo_comanda((select c from comandas c where c.id = v_nova)));
end $$;

revoke all on function separar_comanda(uuid, uuid[], text) from public, anon;
grant execute on function separar_comanda(uuid, uuid[], text) to authenticated;
