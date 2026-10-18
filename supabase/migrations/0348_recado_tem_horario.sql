-- 0348 — O RECADO DO ROBÔ GANHA DIA E HORA
--
-- O recado (mig 0314) é texto fixo: a loja escreve "nosso Happy Hour está
-- funcionando" e o robô repete sempre que alguém pergunta de promoção. Só que
-- promoção tem hora. No Braseiro (18/10/2026, um DOMINGO às 18h16) o cliente
-- perguntou "Hj tem happy hour?" e o robô respondeu que sim — o texto até
-- explicava "de segunda a sexta", mas começava com "Sim, está funcionando!",
-- que é o que a pessoa lê.
--
-- A categoria Happy Hour já tinha a janela certa (18h-20h, seg-sex, mig 0096);
-- quem não sabia do calendário era o recado. Agora ele sabe:
--
--   recado_dias        -- dias da semana em que vale (0=domingo .. 6=sábado)
--   recado_hora_inicio -- começa
--   recado_hora_fim    -- termina
--   recado_pula_feriado-- feriado da loja não conta, mesmo caindo num dia bom
--
-- Tudo NULL = vale sempre, que é como as lojas de hoje já estão. Ninguém
-- precisa mexer em nada pra continuar funcionando igual.

alter table whatsapp_config
  add column if not exists recado_dias          smallint[],
  add column if not exists recado_hora_inicio   time,
  add column if not exists recado_hora_fim      time,
  add column if not exists recado_pula_feriado  boolean not null default true;

comment on column whatsapp_config.recado_dias is
  'Dias da semana em que o recado vale (0=domingo..6=sábado). NULL = todos.';
comment on column whatsapp_config.recado_hora_inicio is
  'Hora em que o recado passa a valer. NULL = o dia inteiro.';
comment on column whatsapp_config.recado_hora_fim is
  'Hora em que o recado deixa de valer. NULL = o dia inteiro.';
comment on column whatsapp_config.recado_pula_feriado is
  'Feriado cadastrado em dias_excecao derruba o recado mesmo em dia/hora válidos.';

-- O Braseiro, que é de onde veio o caso: seg-sex, 18h-20h, sem feriado.
update whatsapp_config
set recado_dias = '{1,2,3,4,5}', recado_hora_inicio = '18:00', recado_hora_fim = '20:00'
where empresa_id = '0571a446-84a3-4bb4-af42-5333fe7efdc9';
