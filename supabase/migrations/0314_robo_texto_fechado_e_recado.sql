-- DOIS TEXTOS QUE A LOJA PASSA A ESCREVER (09/10/2026)
--
-- 1) texto_fechado — o "tá fechado" era um texto só, igual pra todas. Cada
--    loja fala de um jeito e tem coisa pra dizer ali: o Braseiro fecha o
--    DELIVERY às 18h e continua com o salão cheio. Tokens: {abre} vira "hoje
--    às 18:00" / "amanhã das 18:00 às 23:00", {link} vira o cardápio com o
--    telefone do cliente. Em branco = o texto padrão de sempre.
--
-- 2) recado — o aviso do dia, que o robô responde quando perguntam. Nasceu do
--    Happy Hour do Braseiro: a promoção é SÓ no salão e quem pede delivery
--    paga o preço normal. Isso não cabe no cadastro do produto (lá o preço é
--    um só) e é exatamente o tipo de regra que sai errada quando alguém
--    responde de cabeça.
--    `recado_palavras` são gatilhos extras, separados por vírgula — além de
--    promoção/promo/oferta/desconto/happy hour, que já valem sempre.
alter table public.whatsapp_config
  add column if not exists texto_fechado    text,
  add column if not exists recado_ativo     boolean not null default false,
  add column if not exists recado_texto     text,
  add column if not exists recado_palavras  text;

comment on column public.whatsapp_config.texto_fechado is
  'Mensagem de loja fechada escrita pela loja; {abre} e {link} viram os valores reais (mig 0314)';
comment on column public.whatsapp_config.recado_texto is
  'Aviso do dia (promoção, happy hour): o robô responde isto quando perguntam (mig 0314)';
comment on column public.whatsapp_config.recado_palavras is
  'Palavras extras que puxam o recado, separadas por vírgula (mig 0314)';
