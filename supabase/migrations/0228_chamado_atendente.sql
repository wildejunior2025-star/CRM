-- =========================================================
-- 0228: chamado de atendente + pausa automática do robô
-- =========================================================
-- Duas coisas que faltavam pro robô sem IA (mig 0226) parecer gente:
--
-- 1) A LOJA ASSUMIU A CONVERSA. Hoje o robô só cala se alguém apertar "Pausar"
--    no painel. Quando o dono responde pelo celular dele — que é o normal — o
--    robô continua falando por cima. Passa a calar sozinho; mas com PRAZO, e
--    não pra sempre: pausa eterna mata o robô número a número e ninguém
--    percebe. `expira_em` NULL continua sendo o que sempre foi (pausa manual,
--    permanente, só o botão Reativar desfaz).
--
-- 2) CHAMADO DE ATENDENTE. O robô responde cardápio, horário, endereço e taxa.
--    O resto ele não inventa: pergunta se pode chamar uma pessoa, e é isso que
--    fica registrado aqui. Enquanto o chamado está aberto o robô fica quieto
--    naquele número — quem responde é gente — e o gestor toca até alguém abrir.
-- =========================================================

ALTER TABLE public.whatsapp_bot_pausado
  -- NULL = pra sempre (a pausa manual de sempre). Com data = pausa automática.
  ADD COLUMN IF NOT EXISTS expira_em timestamptz,
  ADD COLUMN IF NOT EXISTS motivo text;

CREATE TABLE IF NOT EXISTS public.whatsapp_chamados (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  phone        text NOT NULL,
  nome         text,
  -- O que o cliente escreveu e o robô não soube responder. É o que faz o
  -- atendente saber do que se trata antes de abrir a conversa.
  motivo       text,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  atendido_em  timestamptz,
  atendido_por uuid
);

-- Um chamado aberto por número: o cliente que insiste não pode virar cinco
-- alarmes tocando no balcão.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_chamados_aberto_uniq
  ON public.whatsapp_chamados (empresa_id, phone)
  WHERE atendido_em IS NULL;

CREATE INDEX IF NOT EXISTS whatsapp_chamados_empresa_idx
  ON public.whatsapp_chamados (empresa_id, criado_em DESC);

ALTER TABLE public.whatsapp_chamados ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Loja ve seus chamados" ON public.whatsapp_chamados;
CREATE POLICY "Loja ve seus chamados" ON public.whatsapp_chamados
  FOR SELECT USING (empresa_id = current_empresa_id() OR current_perfil() = 'super_admin');

DROP POLICY IF EXISTS "Loja atende seus chamados" ON public.whatsapp_chamados;
CREATE POLICY "Loja atende seus chamados" ON public.whatsapp_chamados
  FOR UPDATE USING (empresa_id = current_empresa_id())
  WITH CHECK (empresa_id = current_empresa_id());

-- O alarme só serve se chegar sem recarregar a tela.
DO $do$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.whatsapp_chamados;
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

COMMENT ON TABLE public.whatsapp_chamados IS
  'Cliente pediu atendente humano no WhatsApp. Enquanto atendido_em e NULL, o robo nao responde esse numero e o gestor toca.';
