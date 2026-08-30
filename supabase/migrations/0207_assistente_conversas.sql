-- 0207: histórico do assistente de IA da loja
--
-- Guarda cada pergunta e resposta do botão flutuante do Portal.
--
-- Por que salvar, já que o lojista raramente vai reler: as perguntas são o
-- melhor mapa de onde o sistema confunde. Dez lojistas perguntando "como emito
-- nota fiscal?" é uma tela mal resolvida (ou um vídeo faltando), e essa lista
-- se escreve sozinha. Pergunta que a IA não soube responder é ferramenta que
-- está faltando nela.
--
-- Também grava tokens e custo por pergunta. Sem isso a decisão "trocar de
-- modelo pra economizar?" seria no chute; com isso, em um mês tem número.
--
-- LIMPAR ≠ APAGAR: quando o lojista clica em limpar, a linha ganha
-- `oculto_em` e some da tela DELE — mas continua aqui pro Super Admin. Não é
-- pegadinha: é o mesmo trato de qualquer suporte que guarda o chamado. Se um
-- dia precisar apagar de verdade (LGPD, pedido do lojista), é DELETE mesmo.

CREATE TABLE IF NOT EXISTS public.assistente_conversas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pergunta      text NOT NULL,
  resposta      text NOT NULL,
  -- Quais consultas a IA precisou fazer (['consultar_vendas', ...]). Mostra se
  -- ela está usando as ferramentas certas ou respondendo de cabeça.
  consultas     jsonb NOT NULL DEFAULT '[]',
  videos        jsonb NOT NULL DEFAULT '[]',
  tokens_in     integer NOT NULL DEFAULT 0,
  tokens_cache  integer NOT NULL DEFAULT 0,  -- lidos do cache (custam 10%)
  tokens_out    integer NOT NULL DEFAULT 0,
  custo_usd     numeric(10,6) NOT NULL DEFAULT 0,
  modelo        text,
  -- Quando o lojista limpou a conversa. Some da tela dele, fica pro Super Admin.
  oculto_em     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assist_conv_empresa
  ON public.assistente_conversas(empresa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assist_conv_user
  ON public.assistente_conversas(user_id, created_at DESC);

ALTER TABLE public.assistente_conversas ENABLE ROW LEVEL SECURITY;

-- A loja lê só as conversas DELA. `oculto_em` não entra aqui: quem filtra o
-- que foi limpo é a tela. Na RLS ele só atrapalharia o próprio UPDATE de limpar.
DROP POLICY IF EXISTS assistente_conversas_loja_select ON public.assistente_conversas;
CREATE POLICY assistente_conversas_loja_select ON public.assistente_conversas
  FOR SELECT TO authenticated
  USING (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

-- Limpar é o ÚNICO update que a loja pode fazer. Sem restringir a coluna, um
-- lojista curioso poderia reescrever a própria pergunta no seu histórico.
DROP POLICY IF EXISTS assistente_conversas_loja_ocultar ON public.assistente_conversas;
CREATE POLICY assistente_conversas_loja_ocultar ON public.assistente_conversas
  FOR UPDATE TO authenticated
  USING      (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK (empresa_id = (SELECT empresa_id FROM profiles WHERE id = auth.uid()));

-- Quem grava é a edge function, com service role — a loja não insere nem apaga.

DROP POLICY IF EXISTS assistente_conversas_super_admin ON public.assistente_conversas;
CREATE POLICY assistente_conversas_super_admin ON public.assistente_conversas
  FOR ALL TO authenticated
  USING      (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

-- Trava de segurança pro UPDATE de limpar: a loja só mexe em `oculto_em`.
-- A RLS sozinha diz QUAIS linhas ela alcança, não QUAIS colunas — sem isto ela
-- poderia trocar a resposta que a IA deu e o seu histórico viraria ficção.
CREATE OR REPLACE FUNCTION public.assistente_conversas_so_ocultar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_perfil() = 'super_admin' THEN
    RETURN NEW;
  END IF;
  IF NEW.pergunta   IS DISTINCT FROM OLD.pergunta
  OR NEW.resposta   IS DISTINCT FROM OLD.resposta
  OR NEW.consultas  IS DISTINCT FROM OLD.consultas
  OR NEW.videos     IS DISTINCT FROM OLD.videos
  OR NEW.tokens_in  IS DISTINCT FROM OLD.tokens_in
  OR NEW.tokens_out IS DISTINCT FROM OLD.tokens_out
  OR NEW.custo_usd  IS DISTINCT FROM OLD.custo_usd
  OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
  OR NEW.user_id    IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'So da pra limpar a conversa, nao editar.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_assistente_conversas_so_ocultar ON public.assistente_conversas;
CREATE TRIGGER trg_assistente_conversas_so_ocultar
  BEFORE UPDATE ON public.assistente_conversas
  FOR EACH ROW EXECUTE FUNCTION public.assistente_conversas_so_ocultar();

COMMENT ON TABLE public.assistente_conversas IS
  'Perguntas e respostas do assistente de IA do Portal. `oculto_em` = o lojista limpou a vista dele; a linha continua para o Super Admin.';
