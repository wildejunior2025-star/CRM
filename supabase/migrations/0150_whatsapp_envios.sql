-- SABER SE A MENSAGEM CHEGOU (WhatsApp Cloud da Meta)
--
-- A Cloud API responde 200 na hora ("aceitei") e só DEPOIS, por webhook, diz se
-- entregou ou falhou — e o motivo (número não existe, fora da janela de 24h,
-- bloqueio…). Como o whatsapp-webhook ignorava esses avisos de status, a tela
-- dizia "enviado" e ninguém nunca sabia que a mensagem tinha morrido no caminho.
-- Foi o que aconteceu na Estação em 10/08/2026.
--
-- Esta tabela guarda cada envio e o que a Meta respondeu depois.

CREATE TABLE IF NOT EXISTS public.whatsapp_envios (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  message_id  text UNIQUE,              -- id da mensagem na Meta (wamid...)
  telefone    text NOT NULL,            -- pra quem tentamos mandar
  wa_id       text,                     -- pra quem a Meta REALMENTE resolveu
  assunto     text,                     -- de onde partiu (ex.: 'link do cliente')
  -- aceito → enviado → entregue → lido, ou falhou
  status      text NOT NULL DEFAULT 'aceito',
  erro_code   int,
  erro_msg    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whatsapp_envios IS
  'Um registro por mensagem enviada pela Cloud API, com o status que a Meta devolve depois (mig 0150).';

CREATE INDEX IF NOT EXISTS idx_wa_envios_empresa ON public.whatsapp_envios(empresa_id, created_at DESC);

ALTER TABLE public.whatsapp_envios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Empresa ve os proprios envios" ON public.whatsapp_envios;
CREATE POLICY "Empresa ve os proprios envios"
  ON public.whatsapp_envios FOR SELECT
  TO authenticated
  USING (empresa_id = current_empresa_id());
