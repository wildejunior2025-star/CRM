-- =========================================================
-- 0081: Fila de entregadores por ordem de chegada (Online/vez)
-- =========================================================
-- E4 — Motoqueiro fica Online e entra na fila (ordem = quando ficou online).
-- Só o 1º da fila (na vez) pode aceitar pedidos. Ele clica "Finalizar minha vez"
-- -> entra em PAUSA e o próximo assume. Ao voltar, "despausa" e entra no FIM.
-- Tudo opcional por loja (fila_entregador_ativa); desligado = pool livre de hoje.
-- =========================================================

-- 1. Flag por empresa (default OFF: não muda quem já usa o pool livre)
ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS fila_entregador_ativa boolean NOT NULL DEFAULT false;

-- 2. Estado do entregador (no profile dele)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS entregador_online  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS entregador_pausado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS entregador_fila_em timestamptz;

-- ---------------------------------------------------------
-- 3. RPCs (security definer): o estado da fila é lido/gravado no servidor,
--    sem expor os profiles dos outros entregadores pro cliente.
-- ---------------------------------------------------------

-- Estado do entregador logado + posição na fila
CREATE OR REPLACE FUNCTION entregador_estado()
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_emp uuid := current_empresa_id();
  v_uid uuid := auth.uid();
  v_fila_ativa bool;
  v_online bool;
  v_pausado bool;
  v_fila_em timestamptz;
  v_posicao int;
  v_total int;
BEGIN
  SELECT coalesce(fila_entregador_ativa, false) INTO v_fila_ativa FROM empresas WHERE id = v_emp;
  SELECT entregador_online, entregador_pausado, entregador_fila_em
    INTO v_online, v_pausado, v_fila_em
    FROM profiles WHERE id = v_uid;

  SELECT count(*) INTO v_total
    FROM profiles
    WHERE empresa_id = v_emp AND perfil = 'entregador'
      AND entregador_online IS TRUE AND coalesce(entregador_pausado, false) = false;

  IF coalesce(v_online, false) AND NOT coalesce(v_pausado, false) THEN
    SELECT count(*) + 1 INTO v_posicao
      FROM profiles
      WHERE empresa_id = v_emp AND perfil = 'entregador'
        AND entregador_online IS TRUE AND coalesce(entregador_pausado, false) = false
        AND entregador_fila_em < v_fila_em;
  ELSE
    v_posicao := NULL;
  END IF;

  RETURN json_build_object(
    'fila_ativa', coalesce(v_fila_ativa, false),
    'online',     coalesce(v_online, false),
    'pausado',    coalesce(v_pausado, false),
    'na_vez',     (v_posicao = 1),
    'posicao',    v_posicao,
    'total_fila', v_total
  );
END; $$;

-- Ligar/desligar o Online (ao ligar, entra no fim da fila)
CREATE OR REPLACE FUNCTION entregador_set_online(p_online boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE profiles SET
    entregador_online  = p_online,
    entregador_pausado = false,
    entregador_fila_em = CASE WHEN p_online THEN now() ELSE NULL END
  WHERE id = auth.uid() AND perfil = 'entregador';
END; $$;

-- Finalizar a vez -> entra em pausa (sai da fila), o próximo assume
CREATE OR REPLACE FUNCTION entregador_finalizar_vez()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE profiles SET entregador_pausado = true, entregador_fila_em = NULL
  WHERE id = auth.uid() AND perfil = 'entregador';
END; $$;

-- Voltar pra fila (despausar) -> entra no FIM da fila
CREATE OR REPLACE FUNCTION entregador_voltar_fila()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE profiles SET entregador_pausado = false, entregador_online = true, entregador_fila_em = now()
  WHERE id = auth.uid() AND perfil = 'entregador';
END; $$;

-- Aceitar um pedido do pool respeitando a vez (quando a fila está ativa)
CREATE OR REPLACE FUNCTION entregador_aceitar_pedido(p_pedido uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_emp uuid := current_empresa_id();
  v_uid uuid := auth.uid();
  v_fila_ativa bool;
  v_na_vez bool;
  v_ok int;
BEGIN
  IF current_perfil() <> 'entregador' THEN RETURN false; END IF;
  SELECT coalesce(fila_entregador_ativa, false) INTO v_fila_ativa FROM empresas WHERE id = v_emp;

  IF v_fila_ativa THEN
    SELECT (
      (SELECT count(*) FROM profiles
         WHERE empresa_id = v_emp AND perfil = 'entregador'
           AND entregador_online IS TRUE AND coalesce(entregador_pausado, false) = false
           AND entregador_fila_em < (SELECT entregador_fila_em FROM profiles WHERE id = v_uid)) = 0
      AND (SELECT coalesce(entregador_online, false) AND NOT coalesce(entregador_pausado, false)
             FROM profiles WHERE id = v_uid)
    ) INTO v_na_vez;
    IF NOT coalesce(v_na_vez, false) THEN RETURN false; END IF;
  END IF;

  UPDATE pedidos_delivery
    SET entregador_id = v_uid
    WHERE id = p_pedido AND empresa_id = v_emp AND entregador_id IS NULL
      AND (status = 'pronto' OR (origem = 'ifood' AND status = 'saiu_entrega'));
  GET DIAGNOSTICS v_ok = ROW_COUNT;
  RETURN v_ok > 0;
END; $$;

GRANT EXECUTE ON FUNCTION entregador_estado()                TO authenticated;
GRANT EXECUTE ON FUNCTION entregador_set_online(boolean)     TO authenticated;
GRANT EXECUTE ON FUNCTION entregador_finalizar_vez()         TO authenticated;
GRANT EXECUTE ON FUNCTION entregador_voltar_fila()           TO authenticated;
GRANT EXECUTE ON FUNCTION entregador_aceitar_pedido(uuid)    TO authenticated;
