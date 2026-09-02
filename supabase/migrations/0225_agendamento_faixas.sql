-- =========================================================
-- 0225: agendamento por FAIXA, com limite de pedidos
-- =========================================================
-- O primeiro desenho oferecia horário cravado de 30 em 30 minutos, e a loja
-- levou o problema no primeiro dia: entrou pedido pras 14:30 e ela não tinha
-- como entregar 14:30. Duas coisas estavam erradas:
--
--   1. Prometia hora exata. A loja não trabalha assim — ela entrega "durante a
--      tarde", não "às 14:30 em ponto".
--   2. Não tinha limite. Dez pessoas podiam escolher a mesma hora.
--
-- Agora a loja cadastra as FAIXAS dela e o limite de cada uma. A CD Bom põe uma
-- só ("08:00 às 18:00, até 10 pedidos"); um restaurante põe várias de meia em
-- meia hora. A grade é a mesma todos os dias, dimensionada pelo dia mais forte:
-- no dia fraco o limite não chega perto, e o horário de funcionamento (mig
-- 0097) continua decidindo em que dias elas aparecem.
--
-- Formato: [{ "i": "08:00", "f": "18:00", "limite": 10 }]
-- limite 0 = sem limite.
-- =========================================================

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS agendamento_faixas jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.empresas.agendamento_faixas IS
  'Janelas de agendamento da loja: [{i,f,limite}]. Valem em todo dia que a loja abre. limite 0 = sem limite.';

-- Fim da janela combinada. `agendado_para` continua sendo o começo dela — é ele
-- que manda o pedido pra cozinha na hora certa.
ALTER TABLE public.pedidos_delivery
  ADD COLUMN IF NOT EXISTS agendado_ate timestamptz;

COMMENT ON COLUMN public.pedidos_delivery.agendado_ate IS
  'Fim da janela agendada. Com agendado_para forma o "das 14:00 as 14:30" que loja e cliente combinam.';

-- Quantas vagas restam em cada faixa, num dia.
--
-- Precisa ser RPC: quem monta o checkout é o visitante anônimo, que não pode (e
-- não deve) ler a tabela de pedidos. Aqui ele recebe só a contagem — nada de
-- nome, telefone ou valor de pedido de ninguém.
CREATE OR REPLACE FUNCTION public.agendamento_vagas(p_empresa uuid, p_data date)
RETURNS TABLE (inicio text, fim text, limite int, usados int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f->>'i' AS inicio,
    f->>'f' AS fim,
    COALESCE(NULLIF(f->>'limite', '')::int, 0) AS limite,
    (
      SELECT count(*)::int
      FROM pedidos_delivery p
      WHERE p.empresa_id = p_empresa
        AND p.status <> 'cancelado'
        AND p.agendado_para IS NOT NULL
        -- Conta pelo COMEÇO da janela: é o que fica gravado no pedido, e duas
        -- faixas nunca começam na mesma hora.
        AND (p.agendado_para AT TIME ZONE 'America/Fortaleza')::date = p_data
        AND to_char(p.agendado_para AT TIME ZONE 'America/Fortaleza', 'HH24:MI') = f->>'i'
    ) AS usados
  FROM empresas e,
       LATERAL jsonb_array_elements(COALESCE(e.agendamento_faixas, '[]'::jsonb)) f
  WHERE e.id = p_empresa;
$$;

GRANT EXECUTE ON FUNCTION public.agendamento_vagas(uuid, date) TO anon, authenticated;
