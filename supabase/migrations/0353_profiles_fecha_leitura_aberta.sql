-- Migration 0353: fecha a leitura aberta da tabela profiles
--
-- A policy `bot_read_profiles` (SELECT, public, USING true) deixava QUALQUER um —
-- até quem nem estava logado, só com a chave anon — ler os 477 perfis: nome, e-mail,
-- telefone, endereço e coordenadas de clientes, alunos e donos de loja.
-- O robô do WhatsApp não precisa dela: ele usa service_role, que ignora RLS
-- (o comentário no whatsapp-webhook estava desatualizado).
--
-- ANTES de remover, simulei a remoção numa transação desfeita e comparei, por tipo
-- de usuário, quantas linhas cada um enxerga em 28 tabelas. Só `profiles` mudou:
--   anon 477→0 · cliente 477→1 · admin 477→só a loja dele · equipe→só a equipe da loja
--   super_admin igual. Nenhuma outra tabela mudou (as outras policies só leem o
--   próprio perfil de quem consulta, que continua visível).
--
-- A equipe (vendedor/garçom/cozinheiro/entregador/professor) precisa ler os colegas
-- da mesma loja (nome do garçom no salão, cozinheiros, entregadores). Admin já tinha
-- a policy "Usuario ve o proprio perfil ou admin ve todos". Aluno e cliente nunca
-- aparecem para a equipe.
--
-- COMO DESFAZER, se algo quebrar:
--   CREATE POLICY bot_read_profiles ON public.profiles FOR SELECT TO public USING (true);

SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS "Equipe da mesma loja ve a equipe" ON public.profiles;
CREATE POLICY "Equipe da mesma loja ve a equipe" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    empresa_id IS NOT NULL
    AND empresa_id = (SELECT current_empresa_id())
    AND (SELECT current_perfil()) IN ('vendedor','garcom','cozinheiro','entregador','professor')
    AND perfil NOT IN ('aluno','cliente')
  );

DROP POLICY IF EXISTS "bot_read_profiles" ON public.profiles;
