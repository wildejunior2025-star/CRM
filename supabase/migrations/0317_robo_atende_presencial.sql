-- O ROBÔ PASSA A SABER QUE DÁ PRA COMER NA LOJA (09/10/2026)
--
-- O Braseiro não faz entrega, mas tem 7 mesas. O robô respondia "a gente não
-- faz entrega, só retirada aqui na loja" e mandava embora exatamente o cliente
-- que ia sentar e comer ali. Agora ele responde os dois jeitos de atender
-- (comer na loja / retirar) e também entende "posso comer aí?", "tem mesa?".
--
-- POR QUE UMA CHAVE E NÃO O `presencial_ativo` DA EMPRESA: `presencial_ativo`
-- está ligado em 6 lojas (ele serve pro QR da mesa), e mudar a fala do robô em
-- todas de uma vez não foi o combinado — a CDBom, por exemplo, é sorveteria com
-- mesa mas vive de entrega. Então vale a mesma regra de `resposta_produto_ativo`
-- e `ouvir_audio_ativo`: nasce DESLIGADO e liga loja por loja.
--
-- Mesmo ligada, a chave não inventa nada: o texto sai do cadastro
-- (presencial_ativo + aceita_retirada + aceita_entrega), que é o mesmo que
-- manda na Loja Online. Robô e cardápio não podem dizer coisas diferentes.
alter table public.whatsapp_config
  add column if not exists resposta_presencial_ativo boolean not null default false;

comment on column public.whatsapp_config.resposta_presencial_ativo is
  'Robô conta que dá pra comer na loja (usa empresas.presencial_ativo); começa desligado (mig 0317)';
