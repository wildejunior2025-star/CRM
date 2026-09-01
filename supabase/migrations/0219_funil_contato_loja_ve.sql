-- =========================================================
-- 0219: a própria loja vê quem parou no cadastro dela
-- =========================================================
-- A ideia na 0218 era guardar só pra nós e decidir depois. Decidido: quem
-- precisa ligar de volta pro cliente que travou é o lojista, e a lista já vai
-- pro Dashboard dele (na etapa "Foi pro endereço", atrás de uma seta).
-- =========================================================
DROP POLICY IF EXISTS "Super admin ve contato do funil" ON public.loja_funil_contato;
DROP POLICY IF EXISTS "Loja ve quem parou no cadastro" ON public.loja_funil_contato;
CREATE POLICY "Loja ve quem parou no cadastro" ON public.loja_funil_contato
  FOR SELECT USING (empresa_id = current_empresa_id() OR current_perfil() = 'super_admin');

COMMENT ON TABLE public.loja_funil_contato IS
  'Contato de quem chegou no cadastro da Loja Online e nao fechou pedido. A propria loja le (Dashboard).';
