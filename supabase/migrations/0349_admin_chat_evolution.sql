-- 0349 — O CHAT DO SUPER ADM PASSA A VALER PROS DOIS NÚMEROS DA FWC
--
-- O "Atendimento FWC" só falava pelo número da Cloud API (84 99821-4212). Só
-- que o número OFICIAL da FWC hoje é o 99912-0349, que está na Evolution — e
-- quem escreve pra lá não aparecia em lugar nenhum do sistema. O que existia
-- era o `aviso-fwc-entrada`: ele mandava um aviso no WhatsApp pessoal do dono
-- e respondia "com quem eu falo?" pro contato, mas o TEXTO da conversa não era
-- guardado. Pra responder, só pegando o celular.
--
-- `canal` diz por qual cano a mensagem entrou/saiu:
--   'cloud'     → Meta Cloud API (o que já existia; por isso é o default)
--   'evolution' → o número no Evolution
--
-- Vale notar a diferença prática entre os dois: a Cloud tem a janela de 24h da
-- Meta (passou disso, só modelo aprovado). A Evolution não tem janela nenhuma.

alter table admin_chat
  add column if not exists canal text not null default 'cloud';

alter table admin_chat
  drop constraint if exists admin_chat_canal_check;
alter table admin_chat
  add constraint admin_chat_canal_check check (canal in ('cloud', 'evolution'));

comment on column admin_chat.canal is
  'Por onde a mensagem passou: cloud (Meta) ou evolution. Decide por onde a resposta sai.';

-- A lista de conversas ordena por telefone + data; o canal entra junto porque
-- o mesmo contato pode ter falado nos dois números.
create index if not exists idx_admin_chat_canal_tel
  on admin_chat (canal, telefone, created_at desc);
