-- 0350 — O MOVIMENTO DE ESTOQUE DO PRODUTO PASSA A DIZER QUEM FEZ
--
-- `materia_prima_movimentos` já carimbava o autor (created_by default
-- auth.uid()). `estoque_movimentos` — que é o estoque dos produtos do
-- CATÁLOGO — não tinha coluna nenhuma de autor. Resultado: quem desse baixa
-- num produto dizendo "caiu no chão" não deixava nome.
--
-- São DOIS estoques e os dois precisam de histórico com autor:
--   materia_prima_movimentos → insumo da ficha técnica (hambúrguer, queijo…)
--   estoque_movimentos       → produto do catálogo
--
-- Por que DEFAULT auth.uid() em vez de mexer no código: esta tabela recebe
-- insert de muitos lugares — o front (Estoque, Produtos, Entrada de estoque,
-- Nota por IA, Ficha Técnica, Painel) e onze funções do banco (registrar_venda,
-- fechar_conta_presencial, imprevisto_registrar, pedido do delivery…). Passar
-- o autor em cada um seria mexer em doze lugares e esquecer de um. O default
-- pega todos, inclusive os que ainda não existem.
--
-- Fica NULL quando quem gravou não é gente logada: venda do robô, gatilho do
-- cron, edge function com service_role. Na tela isso aparece como "automático",
-- que é a verdade — ninguém apertou nada.

alter table estoque_movimentos
  add column if not exists created_by uuid default auth.uid();

comment on column estoque_movimentos.created_by is
  'Quem lançou o movimento (auth.uid() no momento do insert). NULL = automático (venda, robô, cron).';

create index if not exists idx_estoque_mov_autor
  on estoque_movimentos (empresa_id, created_at desc);
