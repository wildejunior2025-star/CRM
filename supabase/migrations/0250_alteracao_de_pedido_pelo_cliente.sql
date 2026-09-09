-- =========================================================
-- 0250: o cliente pede pra mudar o pedido; a loja autoriza
-- =========================================================
-- "Finalizei e esqueci a Coca." Hoje o cliente só tem o WhatsApp — e quando a
-- loja é a CDBom, com 280 respostas por dia na mão, a mensagem se perde.
--
-- A parte difícil não é mudar o pedido, é saber SE DÁ. O status mente: a loja
-- raramente marca "saiu pra entrega" na hora, então "em preparo" não prova que
-- a moto ainda está lá. Quem sabe é a pessoa no balcão.
--
-- Por isso a alteração nasce como PEDIDO DE AUTORIZAÇÃO, não como fato. A loja
-- olha e responde. É esse aceite que substitui todas as travas automáticas que
-- não teriam como acertar sozinhas.
--
-- Guardamos a lista INTEIRA proposta, não um diff: aplicar vira uma atribuição
-- e some a classe de bug de merge. E guardamos também a lista de ANTES, que
-- serve de tranca — se o pedido mudou entre o pedir e o aceitar (a loja editou
-- pelo gestor no meio), o aceite falha em vez de atropelar o trabalho dela.
--
-- Só ADICIONAR e REMOVER item. Cancelar continua sendo cancelar, no fluxo que
-- já existe: sobrar zero item aqui é recusado de propósito.
--
-- O estoque disso já está resolvido na 0249 — aplicar a lista nova move só a
-- diferença. Sem aquilo, cada adição furava o estoque em silêncio.
-- =========================================================

CREATE TABLE IF NOT EXISTS public.pedido_alteracoes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  pedido_id     uuid NOT NULL REFERENCES pedidos_delivery(id) ON DELETE CASCADE,

  status        text NOT NULL DEFAULT 'pendente'
                CHECK (status IN ('pendente', 'aceita', 'recusada', 'expirada')),

  -- Lista de antes (tranca) e a proposta inteira.
  itens_antes   jsonb NOT NULL,
  itens_depois  jsonb NOT NULL,

  -- Os valores vêm calculados de fora: o preço por faixa de atacado mora no
  -- JavaScript (precoQuantidade.js) e é usado pela loja online, pelo balcão e
  -- pelo robô. Refazer essa conta em SQL criaria uma segunda verdade, e um dia
  -- as duas discordariam num pedido de R$ 200.
  subtotal_antes  numeric(10,2) NOT NULL,
  subtotal_depois numeric(10,2) NOT NULL,
  total_antes     numeric(10,2) NOT NULL,
  total_depois    numeric(10,2) NOT NULL,

  motivo_recusa text,
  expira_em     timestamptz NOT NULL,
  decidida_em   timestamptz,
  decidida_por  uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Uma pendente por pedido. Sem isto o cliente ansioso manda cinco pedidos de
-- adição e a loja recebe cinco campainhas do mesmo pedido.
CREATE UNIQUE INDEX IF NOT EXISTS pedido_alteracoes_uma_pendente
  ON public.pedido_alteracoes (pedido_id) WHERE status = 'pendente';

CREATE INDEX IF NOT EXISTS pedido_alteracoes_empresa_pendente
  ON public.pedido_alteracoes (empresa_id, status, created_at DESC);

ALTER TABLE public.pedido_alteracoes ENABLE ROW LEVEL SECURITY;

-- Leitura no mesmo modelo do pedido: quem tem o id, vê. É como o cliente sem
-- conta acompanha a resposta (ele guarda o id do pedido no próprio aparelho).
DROP POLICY IF EXISTS "Ve alteracao pelo id" ON public.pedido_alteracoes;
CREATE POLICY "Ve alteracao pelo id" ON public.pedido_alteracoes
  FOR SELECT USING (true);

-- Ninguém escreve direto: só pelas duas funções abaixo, que validam. Sem
-- política de INSERT/UPDATE, a tabela fica fechada para o cliente e para a
-- loja — e as regras ficam num lugar só.

-- ── Pedir a alteração (cliente) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.solicitar_alteracao_pedido(
  p_pedido_id uuid,
  p_itens     jsonb,
  p_subtotal  numeric,
  p_total     numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ped pedidos_delivery;
  v_id  uuid;
BEGIN
  SELECT * INTO v_ped FROM pedidos_delivery WHERE id = p_pedido_id;
  IF v_ped.id IS NULL THEN RAISE EXCEPTION 'Pedido não encontrado'; END IF;

  -- O pedido do iFood é do iFood. Mexer aqui deixaria o app deles com um valor
  -- e a comanda com outro.
  IF v_ped.origem = 'ifood' THEN
    RAISE EXCEPTION 'Pedido do iFood não pode ser alterado por aqui';
  END IF;

  -- Depois que saiu pra entrega não tem como pôr na mesma viagem. Entregue e
  -- cancelado estão fechados: o cashback já foi creditado com o valor velho e a
  -- venda já entrou no fechamento do dia.
  IF COALESCE(v_ped.status, '') NOT IN ('aguardando', 'confirmado', 'em_preparo', 'pronto') THEN
    RAISE EXCEPTION 'Este pedido não aceita mais alteração';
  END IF;

  IF jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    -- Tirar tudo é cancelar, e cancelar tem fluxo próprio (com estorno cheio).
    RAISE EXCEPTION 'Para não levar nada, cancele o pedido';
  END IF;

  IF EXISTS (SELECT 1 FROM pedido_alteracoes
              WHERE pedido_id = p_pedido_id AND status = 'pendente' AND expira_em > now()) THEN
    RAISE EXCEPTION 'Já existe um pedido de alteração esperando a loja responder';
  END IF;

  -- Pendente vencida não trava a próxima: marca e segue.
  UPDATE pedido_alteracoes SET status = 'expirada'
   WHERE pedido_id = p_pedido_id AND status = 'pendente' AND expira_em <= now();

  INSERT INTO pedido_alteracoes (
    empresa_id, pedido_id, itens_antes, itens_depois,
    subtotal_antes, subtotal_depois, total_antes, total_depois, expira_em
  ) VALUES (
    v_ped.empresa_id, v_ped.id, COALESCE(v_ped.itens, '[]'::jsonb), p_itens,
    COALESCE(v_ped.subtotal, 0), p_subtotal, COALESCE(v_ped.total, 0), p_total,
    -- 15 minutos: o suficiente pra alguém no balcão ver, e curto o bastante pra
    -- o cliente não ficar esperando um item que nunca vai ser feito.
    now() + interval '15 minutes'
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.solicitar_alteracao_pedido(uuid, jsonb, numeric, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.solicitar_alteracao_pedido(uuid, jsonb, numeric, numeric) TO anon, authenticated;

-- ── Decidir (loja) ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.decidir_alteracao_pedido(
  p_alteracao_id uuid,
  p_aceitar      boolean,
  p_motivo       text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_alt pedido_alteracoes;
  v_ped pedidos_delivery;
  v_pode boolean;
BEGIN
  SELECT * INTO v_alt FROM pedido_alteracoes WHERE id = p_alteracao_id FOR UPDATE;
  IF v_alt.id IS NULL THEN RAISE EXCEPTION 'Alteração não encontrada'; END IF;

  -- SECURITY DEFINER passa por cima do RLS, então a dona da loja é conferida
  -- aqui na mão.
  --
  -- O COALESCE não é enfeite: quem não é da loja tem current_perfil() = NULL, e
  -- "NOT (NULL OR NULL)" dá NULL -- que não é true, então o IF não disparava e
  -- a exceção nunca acontecia. Anônimo aceitava alteração de pedido alheio.
  -- O teste pegou isso antes de a tela existir.
  v_pode := COALESCE(
    current_perfil() = 'super_admin'
    OR (current_perfil() IN ('admin', 'vendedor', 'cozinheiro')
        AND current_empresa_id() = v_alt.empresa_id),
    false
  );
  IF NOT v_pode THEN
    RAISE EXCEPTION 'Sem permissão para decidir esta alteração';
  END IF;

  IF v_alt.status <> 'pendente' THEN RETURN v_alt.status; END IF;

  IF v_alt.expira_em <= now() THEN
    UPDATE pedido_alteracoes SET status = 'expirada', decidida_em = now()
     WHERE id = v_alt.id;
    RETURN 'expirada';
  END IF;

  IF NOT p_aceitar THEN
    UPDATE pedido_alteracoes
       SET status = 'recusada', motivo_recusa = NULLIF(btrim(COALESCE(p_motivo, '')), ''),
           decidida_em = now(), decidida_por = auth.uid()
     WHERE id = v_alt.id;
    RETURN 'recusada';
  END IF;

  SELECT * INTO v_ped FROM pedidos_delivery WHERE id = v_alt.pedido_id FOR UPDATE;
  IF v_ped.id IS NULL THEN RAISE EXCEPTION 'Pedido não existe mais'; END IF;

  -- Tranca: o pedido mudou entre o pedir e o aceitar (a loja editou pelo gestor
  -- no meio). Aplicar a proposta aqui apagaria o trabalho dela sem avisar.
  IF COALESCE(v_ped.itens, '[]'::jsonb) IS DISTINCT FROM v_alt.itens_antes THEN
    RAISE EXCEPTION 'O pedido mudou desde que o cliente pediu. Peça pra ele mandar de novo.';
  END IF;

  -- Aplicar é uma atribuição só. O estoque se acerta sozinho pela diferença
  -- (0249) e o Financeiro lê o total ao vivo.
  UPDATE pedidos_delivery
     SET itens    = v_alt.itens_depois,
         subtotal = v_alt.subtotal_depois,
         total    = v_alt.total_depois
   WHERE id = v_ped.id;

  UPDATE pedido_alteracoes
     SET status = 'aceita', decidida_em = now(), decidida_por = auth.uid()
   WHERE id = v_alt.id;

  RETURN 'aceita';
END;
$$;

REVOKE ALL ON FUNCTION public.decidir_alteracao_pedido(uuid, boolean, text) FROM public;
GRANT EXECUTE ON FUNCTION public.decidir_alteracao_pedido(uuid, boolean, text) TO authenticated;

-- Tempo real: é assim que a campainha toca no gestor sem ficar perguntando.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.pedido_alteracoes;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
