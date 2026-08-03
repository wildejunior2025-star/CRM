-- 0132_renomear_categoria.sql
-- Renomeia uma categoria E arrasta os produtos junto. Como produtos.categoria é
-- TEXTO (guarda o nome), sem atualizar os produtos eles ficariam órfãos (sumiriam
-- da categoria). Por isso as duas coisas acontecem na mesma transação.

CREATE OR REPLACE FUNCTION public.renomear_categoria(p_id uuid, p_nome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_empresa_id uuid;
  v_nome_antigo text;
  v_novo text := btrim(p_nome);
BEGIN
  SELECT empresa_id INTO v_empresa_id FROM profiles WHERE id = auth.uid();
  IF v_empresa_id IS NULL THEN
    RAISE EXCEPTION 'Empresa não identificada. Faça login novamente.';
  END IF;

  IF v_novo = '' THEN
    RAISE EXCEPTION 'O nome da categoria não pode ficar vazio.';
  END IF;

  SELECT nome INTO v_nome_antigo FROM categorias WHERE id = p_id AND empresa_id = v_empresa_id;
  IF v_nome_antigo IS NULL THEN
    RAISE EXCEPTION 'Categoria não encontrada.';
  END IF;

  -- Nada mudou (só espaços/igual): não faz nada.
  IF v_nome_antigo = v_novo THEN RETURN; END IF;

  -- Já existe OUTRA categoria com esse nome? barra (evita duas iguais / merge acidental).
  IF EXISTS (SELECT 1 FROM categorias WHERE empresa_id = v_empresa_id AND nome = v_novo AND id <> p_id) THEN
    RAISE EXCEPTION 'Já existe uma categoria com esse nome.';
  END IF;

  UPDATE categorias SET nome = v_novo WHERE id = p_id AND empresa_id = v_empresa_id;
  UPDATE produtos SET categoria = v_novo
   WHERE empresa_id = v_empresa_id AND categoria = v_nome_antigo;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.renomear_categoria(uuid, text) TO authenticated;
