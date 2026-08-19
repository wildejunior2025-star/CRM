-- =========================================================
-- CRM FWC Inter — Migration 0170
-- Avisos automáticos de pedido viram MÓDULO de mensalidade
--
-- Decisão do dono (19/08/2026): o aviso de status (confirmado / saiu para
-- entrega / entregue) é texto pronto, não passa por IA — custo praticamente
-- zero. Então entra na mensalidade (R$ 50/mês) em vez de consumir crédito.
-- Crédito continua sendo só do ROBÔ, que gasta IA a cada mensagem lida.
--
-- O controle usa a coluna `modulos` que já existe: chave `avisos`.
-- Ausente = ligado (não quebra quem já usa); `false` = loja não contratou.
--
-- A cobrança dos avisos ficou registrada em whatsapp_creditos_log e foi
-- estornada; a função descontar_credito_whatsapp segue como estava, só pro robô.
-- =========================================================

comment on column empresas.modulos is
  'Módulos contratados pela loja. Chaves usadas: caixa, vendas, estoque, clientes, '
  'delivery, produtos, whatsapp (robô de IA, pré-pago em crédito), avisos (avisos '
  'automáticos de status do pedido, R$ 50/mês na mensalidade — ausente = ligado), '
  'financeiro, presencial, relatorios, funcionarios.';
