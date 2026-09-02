-- =========================================================
-- 0221: sangria/suprimento em CARTÃO — de volta
-- =========================================================
-- A tela do Caixa oferece os três botões (Dinheiro, PIX, Cartão) e o banco
-- estava recusando o cartão com "Forma inválida (use dinheiro ou pix)" — o
-- texto da 0134, ou seja, a versão ANTIGA da função voltou a valer em algum
-- momento depois da 0173 (replay de migração antiga por cima).
--
-- O resto da 0173 está de pé no banco (coluna valor_abertura_cartao, os totais
-- de cartão na view caixa_resumo, fechar_caixa e ultimo_fechamento_caixa com
-- cartão): faltava só a função. Sem ela, a loja que tira dinheiro da conta da
-- maquineta pra pagar fornecedor não consegue registrar, e o esperado em cartão
-- fecha errado no dia seguinte.
--
-- O corpo abaixo é o da 0173. Fica com número maior de propósito: assim ele é o
-- último a valer se as migrações forem reaplicadas em ordem.
-- =========================================================

CREATE OR REPLACE FUNCTION public.registrar_movimento_caixa(
  p_caixa_id uuid, p_tipo text, p_valor numeric,
  p_observacao text DEFAULT NULL::text, p_forma text DEFAULT 'dinheiro'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caixa caixas%rowtype;
  v_forma text := lower(btrim(coalesce(p_forma, 'dinheiro')));
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão para movimentar caixa';
  end if;

  if p_tipo not in ('sangria', 'suprimento') then
    raise exception 'Tipo de movimento inválido';
  end if;

  -- 'cartao' = dinheiro que entra/sai da conta da maquineta. Não mexe na
  -- gaveta: abate do esperado EM CARTÃO, igual o PIX faz no dele.
  if v_forma not in ('dinheiro', 'pix', 'cartao') then
    raise exception 'Forma inválida (use dinheiro, pix ou cartao)';
  end if;

  if p_valor <= 0 then
    raise exception 'Valor inválido';
  end if;

  select * into v_caixa from caixas where id = p_caixa_id;

  if v_caixa is null or v_caixa.status <> 'aberto' then
    raise exception 'Caixa não está aberto';
  end if;

  if v_caixa.aberto_por <> auth.uid() and current_perfil() <> 'admin' then
    raise exception 'Sem permissão para movimentar este caixa';
  end if;

  insert into caixa_movimentos (caixa_id, tipo, valor, observacao, forma, created_by)
  values (p_caixa_id, p_tipo, p_valor, p_observacao, v_forma, auth.uid());
end;
$function$;
