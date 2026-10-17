-- Resposta automática no WhatsApp da FWC (99912-0349).
--
-- Quem chama (lead do anúncio) recebe na hora um "Oi, já vou te atender",
-- uma vez a cada 12 h por contato. Se o Wilde já respondeu à mão esse contato
-- nas últimas 12 h, o robô não se mete na conversa.
--   respondido_em: quando saiu a última resposta automática
--   humano_em:     quando o Wilde mandou a última mensagem à mão pro contato
-- avisado_em deixa de ter default: a linha pode nascer por um humano_em, e
-- isso não pode segurar o aviso de 30 min.

alter table public.aviso_fwc_entrada
  add column if not exists respondido_em timestamptz,
  add column if not exists humano_em timestamptz,
  alter column avisado_em drop not null,
  alter column avisado_em drop default;
