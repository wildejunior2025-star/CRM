-- 0245_posicao_do_entregador.sql
-- Onde o motoboy está agora, pra loja ver no mapa.
--
-- O app do entregador já lia o GPS pra ordenar a rota, mas guardava só no
-- celular dele. Quem está na loja não tinha como responder "cadê o meu pedido"
-- sem ligar pro motoqueiro.
--
-- Tabela à parte e NÃO em `profiles` de propósito: a posição é o dado mais
-- sensível que o sistema guarda, e a RLS de profiles ainda deixa uma loja ler
-- linhas de outra. Aqui a regra é curta e fechada: o entregador escreve só a
-- linha DELE, a loja lê só as da empresa dela.
--
-- Uma linha por entregador (a posição de agora, não o rastro): não interessa
-- por onde ele passou, e histórico de localização de trabalhador é dado que é
-- melhor não ter.
CREATE TABLE IF NOT EXISTS public.entregador_posicoes (
  entregador_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  empresa_id    uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  lat           numeric(10,6) NOT NULL,
  lng           numeric(10,6) NOT NULL,
  precisao_m    numeric,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entregador_posicoes_empresa
  ON public.entregador_posicoes (empresa_id, atualizado_em DESC);

ALTER TABLE public.entregador_posicoes ENABLE ROW LEVEL SECURITY;

-- O entregador manda a posição dele — e só a dele.
DROP POLICY IF EXISTS entregador_grava_a_propria ON public.entregador_posicoes;
CREATE POLICY entregador_grava_a_propria ON public.entregador_posicoes
  FOR INSERT WITH CHECK (entregador_id = auth.uid() AND empresa_id = current_empresa_id());

DROP POLICY IF EXISTS entregador_atualiza_a_propria ON public.entregador_posicoes;
CREATE POLICY entregador_atualiza_a_propria ON public.entregador_posicoes
  FOR UPDATE USING (entregador_id = auth.uid())
  WITH CHECK (entregador_id = auth.uid() AND empresa_id = current_empresa_id());

-- A loja vê os entregadores DELA. O próprio entregador também se vê.
DROP POLICY IF EXISTS loja_le_posicoes ON public.entregador_posicoes;
CREATE POLICY loja_le_posicoes ON public.entregador_posicoes
  FOR SELECT USING (empresa_id = current_empresa_id());

-- Some quando o entregador desliga o app: a linha velha vira mentira na tela.
DROP POLICY IF EXISTS entregador_apaga_a_propria ON public.entregador_posicoes;
CREATE POLICY entregador_apaga_a_propria ON public.entregador_posicoes
  FOR DELETE USING (entregador_id = auth.uid());

COMMENT ON TABLE public.entregador_posicoes IS
  'Posição ATUAL do entregador (uma linha por pessoa, sem rastro). O app do entregador grava enquanto ele está online; a loja vê no painel Entregadores. Mig 0245.';
