-- Apagar uma sangria/suprimento lançado errado — só enquanto o caixa está ABERTO.
--
-- Errar o valor da sangria acontece, e hoje o jeito de consertar era lançar um
-- suprimento do mesmo valor: some no total, mas o extrato fica com duas linhas
-- que nunca existiram. Aqui a linha errada sai de verdade.
--
-- Depois de fechado, não. O fechamento é a foto do dia — se a linha sumisse
-- depois, o valor conferido na hora do fechamento deixaria de bater com o que
-- a tela mostra, e ninguém saberia dizer qual dos dois está certo.
--
-- As mesmas três regras do registrar_movimento_caixa: perfil, empresa e dono do
-- caixa (admin passa por cima do dono, mas não do caixa fechado).

CREATE OR REPLACE FUNCTION public.excluir_movimento_caixa(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp   uuid := current_empresa_id();
  v_mov   caixa_movimentos%ROWTYPE;
  v_caixa caixas%ROWTYPE;
BEGIN
  IF current_perfil() NOT IN ('admin', 'vendedor') THEN
    RAISE EXCEPTION 'Sem permissão para excluir movimento.';
  END IF;

  SELECT * INTO v_mov FROM caixa_movimentos WHERE id = p_id AND empresa_id = v_emp;
  IF v_mov.id IS NULL THEN
    RAISE EXCEPTION 'Movimento não encontrado.';
  END IF;

  SELECT * INTO v_caixa FROM caixas WHERE id = v_mov.caixa_id;
  IF v_caixa.status <> 'aberto' THEN
    RAISE EXCEPTION 'Esse caixa já foi fechado — a sangria não pode mais ser apagada.';
  END IF;

  IF v_caixa.aberto_por <> auth.uid() AND current_perfil() <> 'admin' THEN
    RAISE EXCEPTION 'Sem permissão para mexer neste caixa.';
  END IF;

  DELETE FROM caixa_movimentos WHERE id = p_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.excluir_movimento_caixa(uuid) TO authenticated;
