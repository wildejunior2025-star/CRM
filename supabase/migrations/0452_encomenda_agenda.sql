-- =========================================================
-- 0452: "Vendo sob encomenda" — agenda com vagas por dia (confeitaria)
-- =========================================================
-- Segue a chave `empresas.encomenda_ativa` (mig 0449, desligada em todas as
-- lojas). TUDO aqui só age quando a chave da loja está ligada: loja sem a chave
-- passa pelo gatilho sem ser tocada.
--
--  * categorias.sob_encomenda  — a categoria vende por encomenda (data + vaga).
--  * produtos.qtd_minima       — mínimo de unidades por pedido (ex.: 20 trufas).
--  * encomenda_dias            — a dona libera/bloqueia cada dia e fixa o limite.
--  * empresas.encomenda_antecedencia_dias / encomenda_entrada_pct.
--  * pedidos_delivery.encomenda — marca o pedido que é encomenda.
--  * encomenda_validar(...)    — a regra, no servidor (carrinho misto, mínimo,
--                                antecedência, dia liberado, vaga, entrada PIX).
--  * trg_encomenda_pedido      — roda a regra em todo pedido do cardápio/app.
--  * encomenda_agenda(...)     — o calendário: limite e quanto já foi usado.
-- =========================================================

ALTER TABLE public.categorias
  ADD COLUMN IF NOT EXISTS sob_encomenda boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.categorias.sob_encomenda IS
  'Categoria vendida sob encomenda: exige data (com vaga) e conta no limite do dia. So vale se empresas.encomenda_ativa.';

ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS qtd_minima integer;
ALTER TABLE public.produtos DROP CONSTRAINT IF EXISTS produtos_qtd_minima_check;
ALTER TABLE public.produtos ADD CONSTRAINT produtos_qtd_minima_check
  CHECK (qtd_minima IS NULL OR qtd_minima >= 1);
COMMENT ON COLUMN public.produtos.qtd_minima IS
  'Minimo de unidades por pedido na Loja Online (ex.: 20 trufas, 100 doces). NULL = sem minimo.';

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS encomenda_antecedencia_dias integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS encomenda_entrada_pct integer NOT NULL DEFAULT 50;
ALTER TABLE public.empresas DROP CONSTRAINT IF EXISTS empresas_encomenda_entrada_pct_check;
ALTER TABLE public.empresas ADD CONSTRAINT empresas_encomenda_entrada_pct_check
  CHECK (encomenda_entrada_pct BETWEEN 0 AND 100);

ALTER TABLE public.pedidos_delivery
  ADD COLUMN IF NOT EXISTS encomenda boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.pedidos_delivery.encomenda IS
  'Pedido de encomenda (categoria sob_encomenda). agendado_para guarda o DIA combinado. Conta no limite do dia.';

-- ── Calendário da dona ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.encomenda_dias (
  empresa_id uuid    NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  dia        date    NOT NULL,
  liberado   boolean NOT NULL DEFAULT true,
  limite     integer NOT NULL DEFAULT 0 CHECK (limite >= 0),   -- 0 = sem limite
  PRIMARY KEY (empresa_id, dia)
);
COMMENT ON TABLE public.encomenda_dias IS
  'Dias em que a loja aceita encomenda. Dia sem linha = fechado. limite 0 = sem limite.';

ALTER TABLE public.encomenda_dias ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS encomenda_dias_da_loja ON public.encomenda_dias;
CREATE POLICY encomenda_dias_da_loja ON public.encomenda_dias
  FOR ALL
  USING (empresa_id = (SELECT current_empresa_id()) OR (SELECT current_perfil()) = 'super_admin')
  WITH CHECK (empresa_id = (SELECT current_empresa_id()) OR (SELECT current_perfil()) = 'super_admin');

-- ── Conta os itens: quantos são de encomenda e quantos são "pra agora" ──────
CREATE OR REPLACE FUNCTION public.encomenda_contar_itens(p_empresa uuid, p_itens jsonb)
RETURNS TABLE (enc integer, normal integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(count(*) FILTER (WHERE COALESCE(c.sob_encomenda, false)), 0)::int,
    COALESCE(count(*) FILTER (WHERE NOT COALESCE(c.sob_encomenda, false)), 0)::int
  FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(p_itens) = 'array' THEN p_itens ELSE '[]'::jsonb END
       ) AS i(item)
  LEFT JOIN produtos p
         ON p.id::text = i.item->>'produto_id' AND p.empresa_id = p_empresa
  LEFT JOIN categorias c
         ON c.empresa_id = p_empresa AND c.nome = p.categoria;
$$;

-- ── A regra ──────────────────────────────────────────────────────────────────
-- Devolve NULL quando está tudo certo, ou a frase que o cliente vai ler.
-- VOLATILE de propósito: pega um trava por (loja, dia) pra duas pessoas não
-- levarem a última vaga juntas.
CREATE OR REPLACE FUNCTION public.encomenda_validar(
  p_empresa    uuid,
  p_itens      jsonb,
  p_agendado   timestamptz,
  p_total      numeric DEFAULT NULL,
  p_forma      text    DEFAULT NULL,
  p_pagamentos jsonb   DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e        record;
  v_enc    int;
  v_normal int;
  v_dia    date;
  v_hoje   date;
  v_row    record;
  v_usados int;
  v_min    text;
  v_pix    numeric;
BEGIN
  SELECT encomenda_ativa, encomenda_antecedencia_dias AS ant, encomenda_entrada_pct AS pct
    INTO e FROM empresas WHERE id = p_empresa;
  IF NOT FOUND OR e.encomenda_ativa IS NOT TRUE THEN RETURN NULL; END IF;

  SELECT t.enc, t.normal INTO v_enc, v_normal FROM encomenda_contar_itens(p_empresa, p_itens) t;
  IF COALESCE(v_enc, 0) = 0 THEN RETURN NULL; END IF;

  IF COALESCE(v_normal, 0) > 0 THEN
    RETURN 'Encomenda não pode ir junto com pedido da lanchonete. Faça um pedido só de encomenda e outro para o resto.';
  END IF;

  -- Mínimo por produto (soma as linhas do mesmo produto).
  SELECT string_agg(x.nome || ' (mínimo ' || x.minimo || ' unidades)', ', ')
    INTO v_min
    FROM (
      SELECT p.nome, p.qtd_minima AS minimo, sum(COALESCE(NULLIF(i.item->>'quantidade', '')::numeric, 0)) AS qtd
        FROM jsonb_array_elements(p_itens) AS i(item)
        JOIN produtos p ON p.id::text = i.item->>'produto_id' AND p.empresa_id = p_empresa
       WHERE p.qtd_minima IS NOT NULL AND p.qtd_minima > 1
       GROUP BY p.id, p.nome, p.qtd_minima
    ) x
   WHERE x.qtd < x.minimo;
  IF v_min IS NOT NULL THEN
    RETURN 'Quantidade abaixo do mínimo: ' || v_min || '.';
  END IF;

  IF p_agendado IS NULL THEN RETURN 'Escolha o dia da encomenda.'; END IF;
  v_dia  := (p_agendado AT TIME ZONE 'America/Fortaleza')::date;
  v_hoje := (now() AT TIME ZONE 'America/Fortaleza')::date;
  IF v_dia < v_hoje + COALESCE(e.ant, 3) THEN
    RETURN 'A encomenda precisa de pelo menos ' || COALESCE(e.ant, 3) || ' dias de antecedência.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_empresa::text || v_dia::text));

  SELECT liberado, limite INTO v_row FROM encomenda_dias WHERE empresa_id = p_empresa AND dia = v_dia;
  IF NOT FOUND OR v_row.liberado IS NOT TRUE THEN
    RETURN 'A loja não está aceitando encomenda para esse dia. Escolha outra data.';
  END IF;

  SELECT count(*)::int INTO v_usados
    FROM pedidos_delivery p
   WHERE p.empresa_id = p_empresa
     AND p.encomenda
     AND p.status <> 'cancelado'
     AND (p.agendado_para AT TIME ZONE 'America/Fortaleza')::date = v_dia;
  IF v_row.limite > 0 AND v_usados >= v_row.limite THEN
    RETURN 'Esse dia já lotou. Escolha outra data.';
  END IF;

  -- Entrada pelo PIX online (parte do total pago agora).
  IF p_total IS NOT NULL AND COALESCE(e.pct, 0) > 0 THEN
    IF p_forma = 'pix' THEN
      v_pix := p_total;
    ELSE
      SELECT COALESCE(sum((x->>'valor')::numeric), 0) INTO v_pix
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_pagamentos) = 'array' THEN p_pagamentos ELSE '[]'::jsonb END) x
       WHERE x->>'forma' = 'pix';
    END IF;
    IF v_pix < round(p_total * e.pct / 100.0, 2) - 1.00 THEN
      RETURN 'A encomenda precisa de ' || e.pct || '% de entrada pelo PIX.';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.encomenda_validar(uuid, jsonb, timestamptz, numeric, text, jsonb) TO anon, authenticated;

-- ── Gatilho: roda a regra em todo pedido do cardápio/app ────────────────────
CREATE OR REPLACE FUNCTION public.fn_pedido_encomenda()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ativa boolean;
  v_enc   int;
  v_msg   text;
BEGIN
  IF NEW.origem IS NULL OR NEW.origem NOT IN ('cardapio', 'app') THEN RETURN NEW; END IF;

  SELECT encomenda_ativa INTO v_ativa FROM empresas WHERE id = NEW.empresa_id;
  IF v_ativa IS NOT TRUE THEN RETURN NEW; END IF;

  SELECT t.enc INTO v_enc FROM encomenda_contar_itens(NEW.empresa_id, NEW.itens) t;
  IF COALESCE(v_enc, 0) = 0 THEN RETURN NEW; END IF;

  NEW.encomenda := true;
  v_msg := encomenda_validar(NEW.empresa_id, NEW.itens, NEW.agendado_para,
                             NEW.total, NEW.forma_pagamento, NEW.pagamentos);
  IF v_msg IS NOT NULL THEN
    RAISE EXCEPTION 'ENCOMENDA: %', v_msg USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_encomenda_pedido ON public.pedidos_delivery;
CREATE TRIGGER trg_encomenda_pedido
  BEFORE INSERT ON public.pedidos_delivery
  FOR EACH ROW EXECUTE FUNCTION public.fn_pedido_encomenda();

-- ── Calendário: limite e quanto já foi usado em cada dia ────────────────────
-- RPC porque o visitante anônimo não lê pedidos; recebe só a contagem.
CREATE OR REPLACE FUNCTION public.encomenda_agenda(p_empresa uuid, p_de date, p_ate date)
RETURNS TABLE (dia date, liberado boolean, limite int, usados int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.dia, d.liberado, d.limite,
         (SELECT count(*)::int FROM pedidos_delivery p
           WHERE p.empresa_id = p_empresa AND p.encomenda AND p.status <> 'cancelado'
             AND (p.agendado_para AT TIME ZONE 'America/Fortaleza')::date = d.dia) AS usados
    FROM encomenda_dias d
   WHERE d.empresa_id = p_empresa
     AND d.dia BETWEEN p_de AND p_ate
     AND EXISTS (SELECT 1 FROM empresas e WHERE e.id = p_empresa AND e.encomenda_ativa)
   ORDER BY d.dia;
$$;

GRANT EXECUTE ON FUNCTION public.encomenda_agenda(uuid, date, date) TO anon, authenticated;
