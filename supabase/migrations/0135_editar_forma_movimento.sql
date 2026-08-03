-- 0135_editar_forma_movimento.sql
-- Corrigir a forma (dinheiro/pix) de uma sangria/suprimento já registrado — pra quando
-- lançou como dinheiro mas na verdade saiu/entrou por PIX (ou vice-versa).

CREATE OR REPLACE FUNCTION public.alterar_forma_movimento_caixa(p_id uuid, p_forma text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp   uuid := current_empresa_id();
  v_forma text := lower(btrim(p_forma));
BEGIN
  IF current_perfil() NOT IN ('admin', 'vendedor') THEN
    RAISE EXCEPTION 'Sem permissão para editar movimento.';
  END IF;
  IF v_forma NOT IN ('dinheiro', 'pix') THEN
    RAISE EXCEPTION 'Forma inválida (use dinheiro ou pix).';
  END IF;

  UPDATE caixa_movimentos SET forma = v_forma
   WHERE id = p_id AND empresa_id = v_emp;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Movimento não encontrado.';
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.alterar_forma_movimento_caixa(uuid, text) TO authenticated;
