-- O cliente logado no app (sem empresa) não conseguia ler as categorias das lojas:
-- só havia leitura pública pro ANON e a policy da própria empresa pro dono.
-- Efeito: o app não recebia a ordem do cardápio (caía no alfabético) nem a marca
-- "só no salão" (oculta_online). O ANON já lê tudo isso, então liberar pro
-- usuário logado não expõe nada novo.

CREATE POLICY "Autenticado le categorias"
  ON public.categorias
  FOR SELECT
  TO authenticated
  USING (true);
