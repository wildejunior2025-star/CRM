-- =========================================================
-- 0331: desperdício de MATÉRIA-PRIMA (hambúrguer que caiu) + QUEM lançou
-- =========================================================
-- O vendedor que está na loja (sem o dono) precisa dar baixa do que se perdeu —
-- o hambúrguer que caiu no chão — SEM poder mexer no estoque livremente. O estoque
-- de matéria-prima (materia_prima_movimentos) é só do dono: o vendedor não escreve
-- nele. Esta função é a única porta, e ela:
--   * exige o MOTIVO,
--   * grava a saída no estoque do insumo,
--   * lança o prejuízo (quantidade × custo) nos custos imprevistos do dia,
--   * carimba QUEM fez e QUANDO — o dono vê no Financeiro.
--
-- O mesmo "quem" passa a valer também pra baixa de produto (imprevisto_registrar),
-- que até aqui guardava só a hora.
-- =========================================================

ALTER TABLE public.custos_imprevistos
  ADD COLUMN IF NOT EXISTS materia_prima_id uuid REFERENCES public.materias_primas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mp_movimento_id  uuid,
  ADD COLUMN IF NOT EXISTS registrado_por   uuid DEFAULT auth.uid(),
  ADD COLUMN IF NOT EXISTS registrado_por_nome text;

COMMENT ON COLUMN public.custos_imprevistos.registrado_por_nome IS
  'Quem lançou o imprevisto/baixa (nome no momento do lançamento) — mig 0331.';

-- Baixa de produto: igual à da 0318, agora com o nome de quem lançou.
CREATE OR REPLACE FUNCTION public.imprevisto_registrar(
  p_descricao  text,
  p_valor      numeric,
  p_data       date    DEFAULT NULL,
  p_produto_id uuid    DEFAULT NULL,
  p_quantidade numeric DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_emp  uuid := current_empresa_id();
  v_nome text := (SELECT nome FROM public.profiles WHERE id = auth.uid());
  v_mov  uuid;
  v_id   uuid;
BEGIN
  IF coalesce(btrim(p_descricao), '') = '' THEN
    RAISE EXCEPTION 'Descreva o que aconteceu.';
  END IF;
  IF p_produto_id IS NOT NULL AND coalesce(p_quantidade, 0) <= 0 THEN
    RAISE EXCEPTION 'Diga quantos se perderam.';
  END IF;

  IF p_produto_id IS NOT NULL THEN
    INSERT INTO public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao)
    VALUES (v_emp, p_produto_id, 'saida', p_quantidade, 'imprevisto', left(btrim(p_descricao), 200))
    RETURNING id INTO v_mov;
  END IF;

  INSERT INTO public.custos_imprevistos
    (empresa_id, data, descricao, valor, produto_id, quantidade, estoque_movimento_id, registrado_por_nome)
  VALUES
    (v_emp, coalesce(p_data, current_date), btrim(p_descricao), coalesce(p_valor, 0),
     p_produto_id, p_quantidade, v_mov, v_nome)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- Baixa de matéria-prima (hambúrguer, carne...). SECURITY DEFINER porque o
-- vendedor não tem permissão de escrever no estoque do insumo — só por aqui.
CREATE OR REPLACE FUNCTION public.imprevisto_registrar_mp(
  p_materia_prima_id uuid,
  p_quantidade       numeric,
  p_descricao        text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_emp  uuid := current_empresa_id();
  v_nome text := (SELECT nome FROM public.profiles WHERE id = auth.uid());
  v_mp   record;
  v_mov  uuid;
  v_id   uuid;
BEGIN
  IF v_emp IS NULL THEN RAISE EXCEPTION 'Sem empresa.'; END IF;
  IF coalesce(btrim(p_descricao), '') = '' THEN
    RAISE EXCEPTION 'Descreva o que aconteceu.';
  END IF;
  IF coalesce(p_quantidade, 0) <= 0 THEN
    RAISE EXCEPTION 'Diga quantos se perderam.';
  END IF;

  SELECT * INTO v_mp FROM public.materias_primas
   WHERE id = p_materia_prima_id AND empresa_id = v_emp;
  IF NOT FOUND THEN RAISE EXCEPTION 'Insumo não encontrado.'; END IF;

  INSERT INTO public.materia_prima_movimentos
    (empresa_id, materia_prima_id, tipo, quantidade, observacao, created_by)
  VALUES
    (v_emp, v_mp.id, 'saida', p_quantidade,
     'Desperdício — ' || left(btrim(p_descricao), 160) || ' · por ' || coalesce(v_nome, 'usuário'),
     auth.uid())
  RETURNING id INTO v_mov;

  INSERT INTO public.custos_imprevistos
    (empresa_id, data, descricao, valor, quantidade, materia_prima_id, mp_movimento_id, registrado_por_nome)
  VALUES
    (v_emp, current_date, v_mp.nome || ' — ' || btrim(p_descricao),
     round(p_quantidade * coalesce(v_mp.custo, 0), 2), p_quantidade, v_mp.id, v_mov, v_nome)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- Excluir lançamento: devolve o que saiu (produto OU insumo). Só o dono: o
-- vendedor apagar a baixa seria apagar o rastro.
CREATE OR REPLACE FUNCTION public.imprevisto_excluir(p_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE r record;
BEGIN
  IF current_perfil() IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Só o dono pode apagar um lançamento.';
  END IF;

  SELECT * INTO r FROM public.custos_imprevistos
   WHERE id = p_id AND empresa_id = current_empresa_id();
  IF NOT FOUND THEN RETURN; END IF;

  IF r.estoque_movimento_id IS NOT NULL THEN
    INSERT INTO public.estoque_movimentos (empresa_id, produto_id, tipo, quantidade, motivo, observacao)
    VALUES (r.empresa_id, r.produto_id, 'entrada', r.quantidade, 'estorno_imprevisto',
            'Estorno de desperdício: ' || left(coalesce(r.descricao, ''), 180));
  END IF;

  IF r.mp_movimento_id IS NOT NULL AND r.materia_prima_id IS NOT NULL THEN
    INSERT INTO public.materia_prima_movimentos (empresa_id, materia_prima_id, tipo, quantidade, observacao, created_by)
    VALUES (r.empresa_id, r.materia_prima_id, 'ajuste', r.quantidade,
            'Estorno de desperdício: ' || left(coalesce(r.descricao, ''), 180), auth.uid());
  END IF;

  DELETE FROM public.custos_imprevistos WHERE id = p_id;
END $$;

GRANT EXECUTE ON FUNCTION public.imprevisto_registrar_mp(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.imprevisto_excluir(uuid) TO authenticated;
