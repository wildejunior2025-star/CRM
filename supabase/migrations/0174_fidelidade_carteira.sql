-- Fidelidade da loja: indicação e cashback (Fase 1 — a carteira e as regras).
--
-- É um programa POR LOJA e não da FWC. O sistema de pontos que já existe
-- (saldo_pontos) é da plataforma: a carteira dele não tem empresa_id, então o
-- cliente ganharia numa loja pra gastar em qualquer outra da rede — o oposto do
-- que a loja quer. Por isso carteira nova, sempre presa ao empresa_id.
--
-- COMO O CRÉDITO NASCE: um evento só, a PRIMEIRA compra de quem chegou pelo
-- link de indicação de alguém. Ela paga os dois lados de uma vez — quem indicou
-- ganha o percentual de indicação, quem foi indicado ganha o de cashback — e
-- aquele par nunca mais gera nada. Ninguém ganha desconto na hora: a loja não
-- perde margem na venda, ela compra uma segunda visita.
--
-- COMO VIRA DESPESA: o crédito só é custo quando é GASTO, não quando é dado.
-- Crédito que o cliente nunca usa não custa nada pra loja. Por isso a despesa
-- do dia sai dos movimentos de débito, não dos de crédito.
--
-- Esta fase é só a fundação: as tabelas, as funções e a tela de configuração.
-- Nada aqui muda comanda, caixa ou fechamento — isso vem nas fases seguintes, e
-- mesmo lá fica atrás da chave mestra, que nasce DESLIGADA em todas as lojas.

-- ── 1) As regras de cada loja ────────────────────────────────────────────────
-- Uma linha por empresa, criada sob demanda pela tela. A ausência da linha vale
-- como "programa desligado": loja que nunca abriu a tela não tem nada ligado.
CREATE TABLE IF NOT EXISTS public.fidelidade_config (
  empresa_id          uuid PRIMARY KEY REFERENCES public.empresas(id) ON DELETE CASCADE,
  -- Chave mestra. Desligada, nada do programa existe pra essa loja.
  ativo               boolean NOT NULL DEFAULT false,
  -- Quanto QUEM INDICOU ganha da primeira compra do indicado.
  pct_indicacao       numeric NOT NULL DEFAULT 5,
  -- Quanto O INDICADO ganha da própria primeira compra.
  pct_cashback        numeric NOT NULL DEFAULT 5,
  -- Teto por pessoa em cada pagamento: sem ele uma compra de R$ 800 vira R$ 40
  -- do bolso da loja. 0 = sem teto.
  teto_por_pessoa     numeric NOT NULL DEFAULT 20,
  -- Crédito sem prazo é passivo eterno. 0 = não expira.
  validade_dias       integer NOT NULL DEFAULT 90,
  -- Compra mínima pra gerar crédito: impede o pedido de R$ 5 só pra girar.
  compra_minima       numeric NOT NULL DEFAULT 25,
  atualizado_em       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.fidelidade_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fidelidade_config_empresa_all ON public.fidelidade_config;
CREATE POLICY fidelidade_config_empresa_all ON public.fidelidade_config
  FOR ALL TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

-- ── 2) O extrato ─────────────────────────────────────────────────────────────
-- A fonte da verdade. O saldo é derivado daqui, e a despesa do dia também —
-- por isso cada linha guarda a data e o motivo, sem depender de nada externo.
CREATE TABLE IF NOT EXISTS public.creditos_movimentos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id   uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  -- credito  = entrou na carteira (indicação ou cashback)
  -- debito   = o cliente gastou. É ESTE que vira despesa da loja.
  -- expirado = venceu sem ser usado. Sai da carteira mas NÃO é despesa.
  -- estorno  = devolvido (pedido cancelado depois de usar o crédito)
  tipo         text NOT NULL CHECK (tipo IN ('credito','debito','expirado','estorno')),
  -- Sempre positivo; quem decide o sinal é o `tipo`. Evita saldo somado errado
  -- por uma linha negativa que entrou como crédito.
  valor        numeric NOT NULL CHECK (valor > 0),
  motivo       text NOT NULL,        -- 'indicacao' | 'cashback' | 'compra' | 'expiracao' | 'estorno'
  descricao    text,                 -- o que o lojista lê no extrato
  venda_id     uuid,                 -- venda de mesa que consumiu/gerou
  pedido_id    uuid,                 -- pedido de delivery que consumiu/gerou
  indicacao_id uuid,                 -- de qual indicação veio o crédito
  expira_em    date,                 -- só nas linhas de crédito
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creditos_mov_cliente_idx
  ON public.creditos_movimentos (empresa_id, cliente_id, created_at DESC);

-- A despesa do dia é uma varredura por data e tipo: o índice é o que a mantém
-- barata quando a loja tiver anos de extrato.
CREATE INDEX IF NOT EXISTS creditos_mov_despesa_idx
  ON public.creditos_movimentos (empresa_id, tipo, created_at);

ALTER TABLE public.creditos_movimentos ENABLE ROW LEVEL SECURITY;

-- Só leitura pra loja: quem escreve são as funções abaixo (SECURITY DEFINER).
-- Extrato que o próprio usuário pode editar não serve de auditoria.
DROP POLICY IF EXISTS creditos_mov_empresa_sel ON public.creditos_movimentos;
CREATE POLICY creditos_mov_empresa_sel ON public.creditos_movimentos
  FOR SELECT TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

-- ── 3) O saldo ───────────────────────────────────────────────────────────────
-- Poderia ser só um SUM do extrato, mas a comanda consulta isso a cada cliente
-- ligado e o débito precisa travar a linha pra não gastar duas vezes o mesmo
-- crédito. Tabela materializada, mantida só pelas funções.
CREATE TABLE IF NOT EXISTS public.creditos_cliente (
  empresa_id  uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  cliente_id  uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  saldo       numeric NOT NULL DEFAULT 0 CHECK (saldo >= 0),
  total_ganho numeric NOT NULL DEFAULT 0,
  total_gasto numeric NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, cliente_id)
);

ALTER TABLE public.creditos_cliente ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS creditos_cliente_empresa_sel ON public.creditos_cliente;
CREATE POLICY creditos_cliente_empresa_sel ON public.creditos_cliente
  FOR SELECT TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

-- ── 4) Quem indicou quem ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.indicacoes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  indicador_id      uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  indicado_id       uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'pendente'
                    CHECK (status IN ('pendente','pago','recusado')),
  -- Preenchidos quando a primeira compra do indicado conclui.
  valor_compra      numeric,
  credito_indicador numeric,
  credito_indicado  numeric,
  motivo_recusa     text,     -- por que não pagou (compra abaixo do mínimo etc.)
  pago_em           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- Ninguém indica a si mesmo.
  CONSTRAINT indicacoes_nao_auto CHECK (indicador_id <> indicado_id)
);

-- O "uma vez só" mora aqui: um cliente é indicado UMA vez na vida, naquela
-- loja. Sem isto, dá pra reciclar o mesmo indicado em vários indicadores.
CREATE UNIQUE INDEX IF NOT EXISTS indicacoes_indicado_unico_idx
  ON public.indicacoes (empresa_id, indicado_id);

CREATE INDEX IF NOT EXISTS indicacoes_indicador_idx
  ON public.indicacoes (empresa_id, indicador_id, status);

ALTER TABLE public.indicacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS indicacoes_empresa_sel ON public.indicacoes;
CREATE POLICY indicacoes_empresa_sel ON public.indicacoes
  FOR SELECT TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

-- ── 5) Creditar ──────────────────────────────────────────────────────────────
-- Uma porta só pra pôr crédito na carteira: grava o extrato e sobe o saldo na
-- mesma transação, pra os dois nunca discordarem.
CREATE OR REPLACE FUNCTION public.fidelidade_creditar(
  p_empresa_id   uuid,
  p_cliente_id   uuid,
  p_valor        numeric,
  p_motivo       text,
  p_descricao    text DEFAULT NULL,
  p_indicacao_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cfg  fidelidade_config%ROWTYPE;
  v_val  numeric := ROUND(COALESCE(p_valor, 0), 2);
  v_exp  date;
  v_id   uuid;
BEGIN
  IF v_val <= 0 THEN RETURN NULL; END IF;

  SELECT * INTO v_cfg FROM fidelidade_config WHERE empresa_id = p_empresa_id;
  IF v_cfg.empresa_id IS NULL OR NOT v_cfg.ativo THEN
    RETURN NULL;                        -- programa desligado: não credita nada
  END IF;

  -- Teto por pessoa: a loja decide até quanto uma única compra pode render.
  IF COALESCE(v_cfg.teto_por_pessoa, 0) > 0 AND v_val > v_cfg.teto_por_pessoa THEN
    v_val := v_cfg.teto_por_pessoa;
  END IF;

  IF COALESCE(v_cfg.validade_dias, 0) > 0 THEN
    v_exp := (now() AT TIME ZONE 'America/Sao_Paulo')::date + v_cfg.validade_dias;
  END IF;

  INSERT INTO creditos_movimentos
    (empresa_id, cliente_id, tipo, valor, motivo, descricao, indicacao_id, expira_em)
  VALUES
    (p_empresa_id, p_cliente_id, 'credito', v_val, p_motivo, p_descricao, p_indicacao_id, v_exp)
  RETURNING id INTO v_id;

  INSERT INTO creditos_cliente (empresa_id, cliente_id, saldo, total_ganho)
  VALUES (p_empresa_id, p_cliente_id, v_val, v_val)
  ON CONFLICT (empresa_id, cliente_id) DO UPDATE
    SET saldo       = creditos_cliente.saldo + v_val,
        total_ganho = creditos_cliente.total_ganho + v_val,
        updated_at  = now();

  RETURN v_id;
END;
$$;

-- ── 6) Debitar ───────────────────────────────────────────────────────────────
-- Chamada quando o cliente GASTA. É aqui que nasce a despesa da loja.
--
-- O SELECT ... FOR UPDATE é o que impede o mesmo saldo de ser gasto duas vezes
-- quando a comanda fecha no celular do garçom e no PC do caixa ao mesmo tempo.
CREATE OR REPLACE FUNCTION public.fidelidade_debitar(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_valor      numeric,
  p_descricao  text DEFAULT NULL,
  p_venda_id   uuid DEFAULT NULL,
  p_pedido_id  uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_val   numeric := ROUND(COALESCE(p_valor, 0), 2);
  v_saldo numeric;
BEGIN
  IF v_val <= 0 THEN RETURN 0; END IF;

  SELECT saldo INTO v_saldo
  FROM creditos_cliente
  WHERE empresa_id = p_empresa_id AND cliente_id = p_cliente_id
  FOR UPDATE;

  IF v_saldo IS NULL OR v_saldo < v_val THEN
    RAISE EXCEPTION 'Saldo de crédito insuficiente: o cliente tem R$ % e a conta usou R$ %.',
      TO_CHAR(COALESCE(v_saldo, 0), 'FM999999990.00'), TO_CHAR(v_val, 'FM999999990.00');
  END IF;

  INSERT INTO creditos_movimentos
    (empresa_id, cliente_id, tipo, valor, motivo, descricao, venda_id, pedido_id)
  VALUES
    (p_empresa_id, p_cliente_id, 'debito', v_val, 'compra', p_descricao, p_venda_id, p_pedido_id);

  UPDATE creditos_cliente
     SET saldo       = saldo - v_val,
         total_gasto = total_gasto + v_val,
         updated_at  = now()
   WHERE empresa_id = p_empresa_id AND cliente_id = p_cliente_id;

  RETURN v_val;
END;
$$;

-- ── 7) Estornar ──────────────────────────────────────────────────────────────
-- Pedido cancelado depois de o crédito ter sido usado: devolve pra carteira.
-- Não passa pelo `fidelidade_creditar` de propósito — devolução não tem teto,
-- não expira de novo e não pode ser barrada pela chave mestra: se a loja
-- desligou o programa no meio, o crédito que o cliente já tinha é dele.
CREATE OR REPLACE FUNCTION public.fidelidade_estornar(
  p_empresa_id uuid,
  p_cliente_id uuid,
  p_valor      numeric,
  p_descricao  text DEFAULT NULL,
  p_pedido_id  uuid DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_val numeric := ROUND(COALESCE(p_valor, 0), 2);
BEGIN
  IF v_val <= 0 THEN RETURN 0; END IF;

  INSERT INTO creditos_movimentos
    (empresa_id, cliente_id, tipo, valor, motivo, descricao, pedido_id)
  VALUES
    (p_empresa_id, p_cliente_id, 'estorno', v_val, 'estorno', p_descricao, p_pedido_id);

  INSERT INTO creditos_cliente (empresa_id, cliente_id, saldo)
  VALUES (p_empresa_id, p_cliente_id, v_val)
  ON CONFLICT (empresa_id, cliente_id) DO UPDATE
    SET saldo       = creditos_cliente.saldo + v_val,
        total_gasto = GREATEST(0, creditos_cliente.total_gasto - v_val),
        updated_at  = now();

  RETURN v_val;
END;
$$;

-- ── 8) Saldo válido (o que a comanda mostra) ─────────────────────────────────
-- O saldo da carteira menos o que já venceu. Enquanto a expiração não roda, o
-- número da tela precisa já estar certo — senão o garçom oferece um crédito
-- vencido e a loja é obrigada a honrar na frente do cliente.
CREATE OR REPLACE FUNCTION public.fidelidade_saldo(p_cliente_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT GREATEST(0, ROUND(
    COALESCE((SELECT saldo FROM creditos_cliente
               WHERE empresa_id = current_empresa_id() AND cliente_id = p_cliente_id), 0)
    -
    COALESCE((SELECT SUM(valor) FROM creditos_movimentos
               WHERE empresa_id = current_empresa_id()
                 AND cliente_id = p_cliente_id
                 AND tipo = 'credito'
                 AND expira_em IS NOT NULL
                 AND expira_em < (now() AT TIME ZONE 'America/Sao_Paulo')::date), 0)
  , 2));
$$;

GRANT EXECUTE ON FUNCTION public.fidelidade_saldo(uuid) TO authenticated;

-- ── 9) O que o programa custou (a linha do fechamento) ───────────────────────
-- Só os DÉBITOS contam: crédito dado não é despesa, crédito gasto é. Crédito
-- que expirou nunca custou nada, então também fica de fora.
CREATE OR REPLACE FUNCTION public.fidelidade_custo_dia(p_data date)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(
           CASE WHEN tipo = 'debito' THEN valor ELSE -valor END
         ), 0)::numeric
  FROM creditos_movimentos
  WHERE empresa_id = current_empresa_id()
    AND tipo IN ('debito', 'estorno')
    AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = p_data;
$$;

GRANT EXECUTE ON FUNCTION public.fidelidade_custo_dia(date) TO authenticated;

-- ── 10) Painel da loja ───────────────────────────────────────────────────────
-- Uma linha por cliente que participa: quantos trouxe, quanto ganhou, quanto
-- gastou e quanto ainda tem. É a aba "Clientes" da tela nova.
CREATE OR REPLACE VIEW public.fidelidade_clientes AS
  SELECT
    c.id                                   AS cliente_id,
    c.empresa_id,
    c.nome,
    c.telefone,
    COALESCE(cc.saldo, 0)                  AS saldo,
    COALESCE(cc.total_ganho, 0)            AS total_ganho,
    COALESCE(cc.total_gasto, 0)            AS total_gasto,
    COALESCE(ind.pagas, 0)                 AS indicados_pagos,
    COALESCE(ind.pendentes, 0)             AS indicados_pendentes
  FROM clientes c
  LEFT JOIN creditos_cliente cc
         ON cc.empresa_id = c.empresa_id AND cc.cliente_id = c.id
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE i.status = 'pago')     AS pagas,
           COUNT(*) FILTER (WHERE i.status = 'pendente') AS pendentes
    FROM indicacoes i
    WHERE i.empresa_id = c.empresa_id AND i.indicador_id = c.id
  ) ind ON true
  WHERE c.empresa_id = current_empresa_id()
    -- Só quem tem alguma relação com o programa; a lista de clientes inteira
    -- já existe na tela de Clientes e aqui só faria ruído.
    AND (cc.cliente_id IS NOT NULL OR COALESCE(ind.pagas, 0) + COALESCE(ind.pendentes, 0) > 0);
