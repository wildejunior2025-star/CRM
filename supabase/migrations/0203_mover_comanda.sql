-- =========================================================
-- Migration 0203 — Trocar a comanda de mesa
-- =========================================================
-- O cliente senta na 15, o show começa e ele quer a mesa 10, perto do palco.
-- Até aqui o jeito era cancelar a comanda e abrir outra: perdia os itens já
-- lançados e o que a cozinha já tinha feito.
--
-- A comanda não "mora" na mesa, ela só aponta pra ela — então mudar de lugar é
-- redirecionar esse ponteiro e acertar o estado das duas mesas. O que exige
-- cuidado é fazer as três coisas de uma vez só: se a origem for liberada e a
-- gravação do destino falhar, a comanda fica sem lugar nenhum. Por isso é uma
-- função só, numa transação.
--
-- Duas saídas, decididas pelo dono:
--
--  1) Mesa livre  → a comanda troca de mesa e continua "Mesa 10".
--  2) Sentou junto de amigo → NÃO junta as contas (duas contas na mesma mesa
--     viram bagunça na hora de fechar). A comanda sai da mesa e passa a ser
--     identificada pelo NOME do cliente — vira "Comanda 07 · João", que é o
--     mesmo formato que o balcão já usa. As duas contas convivem na mesma mesa
--     física, cada uma fechando sozinha.
-- =========================================================

create or replace function mover_comanda(
  p_comanda_id   uuid,
  p_mesa_destino uuid default null,
  p_nome         text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp    uuid := current_empresa_id();
  v_com    comandas%rowtype;
  v_mesa   mesas%rowtype;
  v_origem uuid;
  v_num    integer;
  v_dia    date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if v_emp is null then raise exception 'Empresa não identificada.'; end if;

  select * into v_com from comandas where id = p_comanda_id and empresa_id = v_emp;
  if v_com.id is null then raise exception 'Comanda não encontrada.'; end if;
  if v_com.status <> 'aberta' then
    raise exception 'Só dá pra mudar de lugar uma comanda aberta.';
  end if;

  v_origem := v_com.mesa_id;

  if p_mesa_destino is not null then
    select * into v_mesa from mesas where id = p_mesa_destino and empresa_id = v_emp;
    if v_mesa.id is null then raise exception 'Mesa não encontrada.'; end if;
    if not v_mesa.ativa then raise exception 'Essa mesa está desativada.'; end if;
    if v_mesa.id = v_origem then raise exception 'A comanda já está nessa mesa.'; end if;

    -- Mesa ocupada não recebe. É o caminho 2 que resolve esse caso.
    if exists (
      select 1 from comandas c
      where c.mesa_id = v_mesa.id and c.status in ('aberta', 'aguardando_conferencia')
    ) then
      raise exception 'A mesa % já tem comanda aberta. Pra sentar junto, passe a comanda para o nome do cliente.', v_mesa.numero;
    end if;

    update comandas
       set mesa_id = v_mesa.id, numero_mesa = v_mesa.numero, tipo = 'mesa', dia = null
     where id = v_com.id;
    update mesas set status = 'ocupada' where id = v_mesa.id;

  else
    -- Vira comanda de nome. O número diário é o mesmo contador do balcão, e o
    -- lock serializa por loja+dia pra dois garçons não tirarem o mesmo número.
    if nullif(btrim(coalesce(p_nome, '')), '') is null then
      raise exception 'Pra tirar da mesa é preciso o nome do cliente.';
    end if;

    perform pg_advisory_xact_lock(hashtext(v_emp::text || v_dia::text));
    select coalesce(max(numero_mesa), 0) + 1 into v_num
      from comandas
     where empresa_id = v_emp and tipo = 'balcao' and dia = v_dia;

    update comandas
       set mesa_id = null, tipo = 'balcao', numero_mesa = v_num,
           nome_cliente = btrim(p_nome), dia = v_dia
     where id = v_com.id;
  end if;

  -- Libera a mesa antiga — mas só se não sobrou ninguém nela (a mesa pode ter
  -- ficado com outra comanda aberta, e liberar apagaria isso da tela).
  if v_origem is not null and not exists (
    select 1 from comandas c
    where c.mesa_id = v_origem and c.status in ('aberta', 'aguardando_conferencia')
  ) then
    update mesas set status = 'livre' where id = v_origem;
  end if;

  select * into v_com from comandas where id = p_comanda_id;
  return jsonb_build_object('ok', true, 'rotulo', rotulo_comanda(v_com));
end $$;

revoke all on function mover_comanda(uuid, uuid, text) from public, anon;
grant execute on function mover_comanda(uuid, uuid, text) to authenticated;
