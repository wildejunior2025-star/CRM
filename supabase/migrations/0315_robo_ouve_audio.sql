-- O ROBÔ DO LINK PASSA A OUVIR ÁUDIO (09/10/2026)
--
-- O cliente manda áudio e o robô ficava mudo — e mudo é o pior dos mundos:
-- quem falou fica esperando uma resposta que não vem (teste real no Braseiro).
-- Agora o áudio vira texto (Whisper) e entra no MESMO robô de graça: preço,
-- horário, taxa e link saem do banco, sem IA generativa.
--
-- O QUE CUSTA: só a transcrição, ~US$ 0,006 por MINUTO de áudio — um áudio de
-- 30 segundos dá menos de dois centavos. Decisão do usuário (09/10): fica por
-- conta da plataforma, sem cobrar da loja; se o volume doer, a gente mede e
-- revê. Quem quiser medir: áudio transcrito entra no histórico começando com
-- "🎤 ", então dá pra contar por loja e por mês em whatsapp_conversas.
--
-- Começa DESLIGADO e ligado só na loja de teste (O Braseiro) — a novidade não
-- entra sozinha em loja que já está rodando.
alter table public.whatsapp_config
  add column if not exists ouvir_audio_ativo boolean not null default false;

comment on column public.whatsapp_config.ouvir_audio_ativo is
  'Robô sem IA transcreve o áudio do cliente (Whisper) e responde pelo texto (mig 0315)';
