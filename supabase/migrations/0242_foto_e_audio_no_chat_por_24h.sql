-- 0242_foto_e_audio_no_chat_por_24h.sql
-- A foto e o áudio do WhatsApp aparecem no chat do gestor — e somem no dia
-- seguinte.
--
-- Hoje a mídia é jogada fora: a foto vira o texto "📷 Foto" e o áudio vira
-- "🎤 Áudio". Quem atende vê que veio alguma coisa e não tem como abrir.
--
-- A decisão de guardar por 24 HORAS é o que torna isto barato e simples: o
-- sistema é pra atender AGORA. Quem precisar rever a foto de ontem abre o
-- WhatsApp, que é onde a conversa mora de verdade. Sem isso eu teria que
-- inventar cota por loja e faxina por tamanho — com isso, o gasto é constante
-- e nunca acumula.
--
-- A mídia é baixada NA HORA que o webhook recebe, não quando alguém clica: a
-- Meta só deixa buscar o arquivo por pouco tempo depois que ele chega. Esperar
-- o clique é garantir que metade não vai estar mais lá.

ALTER TABLE public.mensagens_chat
  ADD COLUMN IF NOT EXISTS midia_path       text,
  ADD COLUMN IF NOT EXISTS midia_tipo       text,
  ADD COLUMN IF NOT EXISTS midia_expira_em  timestamptz;

COMMENT ON COLUMN public.mensagens_chat.midia_path IS
  'Caminho do arquivo no bucket chat-midias: {empresa_id}/{ano-mes-dia}/{uuid}.{ext} (mig 0242). '
  'Some depois de 24h — a conversa fica, o arquivo não.';
COMMENT ON COLUMN public.mensagens_chat.midia_tipo IS
  'imagem | audio | video | documento';

CREATE INDEX IF NOT EXISTS idx_mensagens_chat_midia_expira
  ON public.mensagens_chat (midia_expira_em)
  WHERE midia_path IS NOT NULL;

-- ── O lugar de guardar ───────────────────────────────────────────────────────
-- PRIVADO. É foto de cliente: endereço, receita, nota, a criança dele. O chat
-- gera um link assinado na hora de mostrar, e ele vence junto com a sessão.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-midias', 'chat-midias', false, 20971520,
  ARRAY['image/jpeg','image/png','image/webp','image/gif',
        'audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/webm',
        'video/mp4','video/3gpp','application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- A loja lê só a pasta dela. A primeira pasta do caminho é o empresa_id, e é
-- isso que a política compara — sem isso uma loja veria a foto do cliente da
-- outra, que é o tipo de vazamento que não tem desculpa.
DROP POLICY IF EXISTS "chat-midias loja le" ON storage.objects;
CREATE POLICY "chat-midias loja le" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-midias'
    AND (storage.foldername(name))[1] = current_empresa_id()::text
  );

-- Quem escreve é o robô (service_role, pelas edge functions). Ninguém mais.
DROP POLICY IF EXISTS "chat-midias servico escreve" ON storage.objects;
CREATE POLICY "chat-midias servico escreve" ON storage.objects
  FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'chat-midias');

DROP POLICY IF EXISTS "chat-midias servico apaga" ON storage.objects;
CREATE POLICY "chat-midias servico apaga" ON storage.objects
  FOR DELETE TO service_role
  USING (bucket_id = 'chat-midias');

-- ── A lista do que já venceu ─────────────────────────────────────────────────
-- O SQL não apaga arquivo do storage; quem faz isso é a edge function
-- `limpar-midias-chat`. Ela pergunta aqui o que apagar.
CREATE OR REPLACE FUNCTION public.midias_do_chat_vencidas(p_limite int DEFAULT 500)
RETURNS TABLE (id uuid, midia_path text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.midia_path
  FROM mensagens_chat m
  WHERE m.midia_path IS NOT NULL
    AND m.midia_expira_em IS NOT NULL
    AND m.midia_expira_em < now()
  ORDER BY m.midia_expira_em
  LIMIT greatest(1, least(p_limite, 2000));
$$;

-- Apagado o arquivo, a mensagem perde o anexo mas CONTINUA na conversa. Some a
-- foto, não o registro de que ela existiu — quem lê a conversa amanhã precisa
-- entender por que tem um "📷 Foto" ali sem imagem.
CREATE OR REPLACE FUNCTION public.marcar_midias_apagadas(p_ids uuid[])
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n int;
BEGIN
  UPDATE mensagens_chat
     SET midia_path = NULL, midia_expira_em = NULL
   WHERE id = ANY(p_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.midias_do_chat_vencidas(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.midias_do_chat_vencidas(int) TO service_role;
REVOKE ALL ON FUNCTION public.marcar_midias_apagadas(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.marcar_midias_apagadas(uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';
