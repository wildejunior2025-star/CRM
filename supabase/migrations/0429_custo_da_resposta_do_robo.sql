-- O robô que fala com o cliente passa a GUARDAR quanto custou cada resposta.
--
-- Até aqui o custo só existia num console.log, que o Supabase joga fora em 24
-- horas. Resultado: "a conta fecha com R$ 0,07 por resposta?" não tinha
-- resposta, só opinião — e sem isso não dá pra decidir preço nenhum. O
-- assistente do grupo já grava o dele em assistente_conversas; o robô do
-- cliente passa a gravar na mesma tabela, em canal próprio ("whatsapp_cliente").
--
-- Só falta uma coisa pra isso caber: do outro lado da conversa tem um CLIENTE
-- da loja, que não é usuário do sistema. user_id era NOT NULL porque toda
-- conversa vinha do Portal, onde sempre tem alguém logado.

alter table assistente_conversas alter column user_id drop not null;

comment on column assistente_conversas.user_id is
  'Quem perguntou, quando foi gente do sistema (Portal, grupo da loja). Nulo no canal whatsapp_cliente: do outro lado está um cliente da loja, que não tem login.';

comment on column assistente_conversas.canal is
  'portal | whatsapp_pergunta | whatsapp_estoque | whatsapp_comando | whatsapp_cliente. Só portal e whatsapp_pergunta consomem a franquia de IA (ver carteiraIa.verCarteira); whatsapp_cliente é medição do robô de atendimento.';
