-- =========================================================
-- 0226: resposta automática com o link do cardápio
-- =========================================================
-- O robô de IA existe, mas nenhuma loja usa: ele gasta crédito a cada mensagem,
-- e cada coisa nova do sistema (faixa de preço, cashback, agendamento) é mais
-- uma coisa pra ensinar a ele — que ele erra. Hoje, com a IA desligada nas três
-- lojas conectadas, a mensagem do cliente é só guardada: ele fala e ninguém
-- responde até alguém abrir o WhatsApp.
--
-- Esta é a resposta que não precisa de IA nenhuma: manda o link do cardápio,
-- já com o telefone dele, pra o checkout abrir com nome e endereço preenchidos.
-- Custo zero, nada pra ensinar, e tudo que o sistema ganha (agendamento,
-- cashback, taxa por bairro) passa a valer no WhatsApp no mesmo dia — porque
-- quem faz o pedido é o cardápio, não o robô.
--
-- Desligado por padrão: resposta automática é a loja falando com o cliente
-- dela, ninguém liga isso por baixo.
-- =========================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS resposta_link_ativo boolean NOT NULL DEFAULT false,
  -- Texto próprio da loja (opcional). Vazio = o padrão da plataforma.
  ADD COLUMN IF NOT EXISTS resposta_link_texto text;

COMMENT ON COLUMN public.whatsapp_config.resposta_link_ativo IS
  'Responde automaticamente com o link do cardapio quando o robo de IA esta desligado. Nao consome credito.';
