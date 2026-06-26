-- =========================================================
-- 0055: Autoatendimento por QR Code da mesa
-- =========================================================
-- Cada mesa ganha um token único (vai no QR). O cliente abre a página
-- pública /mesa/:token, escolhe os itens e eles entram na comanda da mesa
-- (direto pra cozinha, sem garçom). Pagamento continua no fim, pela equipe.
--   mesa_info  → dados da mesa + loja para a página
--   mesa_pedir → cria/usa a comanda da mesa e insere os itens (status pendente)
-- Ambas SECURITY DEFINER e liberadas para anon (cliente sem login).
-- =========================================================

ALTER TABLE mesas ADD COLUMN IF NOT EXISTS token text;
UPDATE mesas SET token = lower(substring(replace(gen_random_uuid()::text,'-',''),1,10))
  WHERE token IS NULL;
ALTER TABLE mesas ALTER COLUMN token
  SET DEFAULT lower(substring(replace(gen_random_uuid()::text,'-',''),1,10));
CREATE UNIQUE INDEX IF NOT EXISTS idx_mesas_token ON mesas(token);

CREATE OR REPLACE FUNCTION public.mesa_info(p_token text)
RETURNS json
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT json_build_object(
    'mesa_id', m.id, 'numero', m.numero, 'nome', m.nome, 'ativa', m.ativa,
    'empresa_id', e.id, 'empresa_nome', e.nome, 'logo_url', e.logo_url,
    'presencial_ativo', e.presencial_ativo
  )
  FROM mesas m JOIN empresas e ON e.id = m.empresa_id
  WHERE m.token = p_token;
$$;

CREATE OR REPLACE FUNCTION public.mesa_pedir(p_token text, p_itens jsonb)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_mesa       mesas%ROWTYPE;
  v_emp        uuid;
  v_presencial boolean;
  v_comanda    uuid;
  v_item       jsonb;
  v_n          integer := 0;
BEGIN
  SELECT * INTO v_mesa FROM mesas WHERE token = p_token;
  IF v_mesa.id IS NULL THEN RAISE EXCEPTION 'Mesa não encontrada.'; END IF;
  IF NOT v_mesa.ativa THEN RAISE EXCEPTION 'Mesa indisponível.'; END IF;

  v_emp := v_mesa.empresa_id;
  SELECT presencial_ativo INTO v_presencial FROM empresas WHERE id = v_emp;
  IF NOT COALESCE(v_presencial, false) THEN
    RAISE EXCEPTION 'Pedido pela mesa indisponível no momento.';
  END IF;
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'Nenhum item no pedido.';
  END IF;

  SELECT id INTO v_comanda FROM comandas
  WHERE mesa_id = v_mesa.id AND status = 'aberta' ORDER BY created_at LIMIT 1;
  IF v_comanda IS NULL THEN
    INSERT INTO comandas (empresa_id, mesa_id, numero_mesa, status, observacoes)
    VALUES (v_emp, v_mesa.id, v_mesa.numero, 'aberta', 'Autoatendimento (QR)')
    RETURNING id INTO v_comanda;
    UPDATE mesas SET status = 'ocupada' WHERE id = v_mesa.id;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    INSERT INTO comanda_itens (empresa_id, comanda_id, produto_id, nome, preco_unitario, quantidade, observacao, status)
    VALUES (v_emp, v_comanda,
            NULLIF(v_item->>'produto_id',''),
            v_item->>'nome',
            COALESCE((v_item->>'preco')::numeric, 0),
            GREATEST(1, COALESCE((v_item->>'qtd')::int, 1)),
            NULLIF(v_item->>'obs',''),
            'pendente');
    v_n := v_n + 1;
  END LOOP;

  RETURN json_build_object('ok', true, 'itens', v_n);
END;
$$;

REVOKE EXECUTE ON FUNCTION mesa_info(text) FROM public;
GRANT  EXECUTE ON FUNCTION mesa_info(text) TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION mesa_pedir(text, jsonb) FROM public;
GRANT  EXECUTE ON FUNCTION mesa_pedir(text, jsonb) TO anon, authenticated;
