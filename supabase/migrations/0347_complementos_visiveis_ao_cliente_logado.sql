-- O cliente logado no app não via os complementos das lojas (18/10/2026).
--
-- Grupos e opções de complemento ("monte sua pizza": sabores, borda...) só tinham leitura
-- pública pro ANON e uma policy "Auth" que exigia `empresa_id = current_empresa_id()`.
-- O cliente do app não tem empresa, então lia ZERO linhas: a pizza "monte a sua" chegava no
-- app sem grupos, aparecia a R$ 0,00 e entrava na sacola sem escolher sabor.
--
-- O ANON já lê tudo isso (é o cardápio público da Loja Online), então liberar a leitura
-- pro usuário logado não expõe nada novo. Escrever segue restrito à própria loja.
-- (O mesmo defeito já tinha acontecido com `categorias` — mig 0341.)

drop policy if exists "Autenticado le complemento_grupos" on public.complemento_grupos;
create policy "Autenticado le complemento_grupos"
  on public.complemento_grupos
  for select
  to authenticated
  using (true);

drop policy if exists "Autenticado le complemento_opcoes" on public.complemento_opcoes;
create policy "Autenticado le complemento_opcoes"
  on public.complemento_opcoes
  for select
  to authenticated
  using (true);
