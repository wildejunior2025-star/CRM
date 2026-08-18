-- 0168_conversa_marca_falha.sql
-- Marca o aviso que NÃO chegou.
--
-- whatsapp-pedido-notify disparava pelo Evolution e gravava a linha em
-- whatsapp_conversas na sequência, SEM olhar a resposta. Instância desconectada,
-- token errado, servidor fora: dava tudo na mesma, a linha era gravada como se
-- tivesse ido. Foi assim que eu disse pro Wilde que o Zebu "estava enviando"
-- quando o cliente não recebia nada.
--
-- Agora o erro fica na própria linha, e "está no histórico" volta a significar
-- "o WhatsApp aceitou".

alter table public.whatsapp_conversas
  add column if not exists falhou boolean not null default false,
  add column if not exists erro   text;

comment on column public.whatsapp_conversas.falhou is
  'true = o WhatsApp recusou o envio (a mensagem não chegou ao cliente)';
