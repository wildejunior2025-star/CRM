-- =========================================================
-- 0216: funil da Loja Online — onde o cliente desiste
-- =========================================================
-- Hoje a loja só enxerga o pedido que fechou. Quem abriu o cardápio e foi
-- embora não deixa rastro nenhum: em 31/08/2026 a CD Bom teve ~53 aberturas do
-- catálogo pelo celular e ZERO pedidos, e não havia como saber se o problema
-- era o cardápio, o preço, o frete ou o cadastro. A resposta só saiu garimpando
-- log de servidor — que some em 24h e não distingue pessoa de recarregamento.
--
-- A etapa que mais importa é a SACOLA, e é justamente a que nunca deu pra
-- medir: a sacola vive dentro do celular do cliente e nada é enviado ao
-- servidor até ele finalizar. É ela que separa "não gostou do cardápio" de
-- "desistiu quando viu o frete".
--
-- Uma linha por etapa alcançada, uma vez por visita. Sem nome, sem telefone,
-- sem IP: só a loja, a etapa e a hora. Quem quer saber quem comprou já tem o
-- pedido; aqui o que interessa é quantos pararam no meio.
-- =========================================================

CREATE TABLE IF NOT EXISTS public.loja_funil (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  -- Identifica a VISITA, não a pessoa: vive no sessionStorage, morre quando a
  -- aba fecha. Recarregar a página continua sendo a mesma visita — sem isso,
  -- um cliente indeciso viraria dez "clientes" no relatório.
  sessao    text NOT NULL,
  etapa     text NOT NULL CHECK (etapa IN ('abriu', 'sacola', 'endereco', 'pedido')),
  -- Valor da sacola quando faz sentido (sacola/endereço/pedido). Serve pra
  -- responder "quanto deixaram no meio do caminho".
  valor     numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Uma linha por etapa por visita. O cliente que volta pra sacola três vezes
-- conta uma; o índice é o que garante isso, não a boa vontade da tela.
CREATE UNIQUE INDEX IF NOT EXISTS loja_funil_sessao_etapa_idx
  ON public.loja_funil (sessao, etapa);

CREATE INDEX IF NOT EXISTS loja_funil_empresa_data_idx
  ON public.loja_funil (empresa_id, created_at DESC);

ALTER TABLE public.loja_funil ENABLE ROW LEVEL SECURITY;

-- Quem registra é o visitante do cardápio, que não tem login — mesma situação
-- de quem faz um pedido pela Loja Online. Só INSERT: ninguém anônimo lê nada.
DROP POLICY IF EXISTS "Visitante registra etapa" ON public.loja_funil;
CREATE POLICY "Visitante registra etapa" ON public.loja_funil
  FOR INSERT WITH CHECK (true);

-- Ler é só da própria loja.
DROP POLICY IF EXISTS "Loja ve o proprio funil" ON public.loja_funil;
CREATE POLICY "Loja ve o proprio funil" ON public.loja_funil
  FOR SELECT USING (empresa_id = current_empresa_id() OR current_perfil() = 'super_admin');

COMMENT ON TABLE public.loja_funil IS
  'Etapas alcançadas por visita na Loja Online (abriu, sacola, endereco, pedido). Mostra onde o cliente desiste.';

-- Tabela nova no schema public NÃO fica exposta na API por padrão (o Supabase
-- parou de liberar sozinho). Sem estes GRANTs a política acima nem chega a ser
-- avaliada: o insert do visitante volta 401 e o funil fica vazio pra sempre,
-- sem erro nenhum aparecendo na loja.
GRANT INSERT ON public.loja_funil TO anon, authenticated;
GRANT SELECT ON public.loja_funil TO authenticated;
