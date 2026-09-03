-- =========================================================
-- Migration 0229 — Separar a conta levando só PARTE da quantidade
-- =========================================================
-- A 0205 já tirava da mesa a conta de quem vai embora, mas só em item INTEIRO:
-- os itens marcados mudavam de comanda como estavam. Na mesa real isso não
-- fecha. Dois amigos pedem "6 litrinhos" — que entram como UMA linha de
-- quantidade 6 — e um deles vai embora devendo 3. Não havia como marcar 3: ou
-- levava os 6, ou não levava nada. E, pior, se a mesa só tinha aquela linha o
-- botão "Separar conta" nem aparecia (ele pedia 2+ LINHAS).
--
-- Aqui a linha se PARTE: 3 unidades vão pra comanda dela, 3 ficam na mesa. A
-- cópia leva tudo o que a linha tinha (observação, setor, status, quem lançou,
-- quem entregou, isenção de taxa), porque é a mesma bebida — só mudou de conta.
--
-- Parâmetro novo `p_partes` (jsonb: [{"id": "...", "qtd": 3}]) em vez do
-- `p_itens uuid[]`. A função antiga fica de pé de propósito: o garçom com a
-- tela aberta na hora do deploy continua conseguindo separar a conta até
-- recarregar. Os nomes dos parâmetros são diferentes, então o PostgREST sabe
-- qual das duas chamar sem ambiguidade.
-- =========================================================

create or replace function separar_comanda(
  p_comanda_id uuid,
  p_partes     jsonb,
  p_nome       text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp      uuid := current_empresa_id();
  v_com      comandas%rowtype;
  v_nova     uuid;
  v_num      integer;
  v_dia      date := (now() at time zone 'America/Sao_Paulo')::date;
  v_sep      integer;   -- unidades que vão com ela
  v_tot      integer;   -- unidades que a comanda tem
  r          record;
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

  -- O que foi marcado, já preso ao que a linha realmente tem: pedir 9 de uma
  -- linha de 6 leva 6, e nunca deixa a mesa com quantidade negativa. Agrupa por
  -- item porque a mesma linha pode vir repetida no jsonb, e ignora id que não é
  -- desta comanda. A mesma consulta aparece duas vezes (aqui e no loop lá
  -- embaixo) de propósito: tabela temporária quebraria se a função rodasse duas
  -- vezes dentro da mesma transação.
  select coalesce(sum(qtd_sep), 0) into v_sep from (
    select least(sum(greatest(coalesce((e->>'qtd')::int, 1), 1)), ci.quantidade) as qtd_sep
      from jsonb_array_elements(coalesce(p_partes, '[]'::jsonb)) e
      join comanda_itens ci
        on ci.id = (e->>'id')::uuid
       and ci.comanda_id = v_com.id
     group by ci.id, ci.quantidade
  ) s;
  select coalesce(sum(quantidade), 0) into v_tot from comanda_itens where comanda_id = v_com.id;

  if v_sep = 0 then raise exception 'Marque pelo menos um item.'; end if;
  -- Levar TUDO não é separar conta, é trocar a comanda de lugar — e deixaria a
  -- mesa ocupada por uma comanda vazia, que ninguém sabe se fecha ou cancela.
  if v_sep >= v_tot then
    raise exception 'Isso levaria a conta inteira. Para mudar a comanda de lugar, use "Trocar de mesa".';
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

  for r in
    select ci.id,
           ci.quantidade as qtd_total,
           least(sum(greatest(coalesce((e->>'qtd')::int, 1), 1)), ci.quantidade) as qtd_sep
      from jsonb_array_elements(coalesce(p_partes, '[]'::jsonb)) e
      join comanda_itens ci
        on ci.id = (e->>'id')::uuid
       and ci.comanda_id = v_com.id
     group by ci.id, ci.quantidade
  loop
    if r.qtd_sep >= r.qtd_total then
      -- Vai a linha toda: só troca de dono, sem duplicar nada.
      update comanda_itens set comanda_id = v_nova where id = r.id;
    else
      -- Parte a linha: a cópia nasce na conta dela com a quantidade dela...
      insert into comanda_itens (empresa_id, comanda_id, produto_id, nome, preco_unitario,
                                 quantidade, observacao, status, entregue_por, entregue_at,
                                 preparando_por, preparando_nome, preparando_em, setor,
                                 lancado_por, isento_taxa, created_at)
      select empresa_id, v_nova, produto_id, nome, preco_unitario,
             r.qtd_sep, observacao, status, entregue_por, entregue_at,
             preparando_por, preparando_nome, preparando_em, setor,
             lancado_por, isento_taxa, created_at
        from comanda_itens where id = r.id;
      -- ...e o que sobrou continua na mesa, na linha de sempre.
      update comanda_itens set quantidade = quantidade - r.qtd_sep where id = r.id;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'comanda_id', v_nova, 'itens', v_sep,
                            'rotulo', rotulo_comanda((select c from comandas c where c.id = v_nova)));
end;
$$;

revoke all on function separar_comanda(uuid, jsonb, text) from public, anon;
grant execute on function separar_comanda(uuid, jsonb, text) to authenticated;
