-- VENDEDOR RECEBE FIADO (03/11/2026)
--
-- Estação do Sabor passou o login do caixa de admin pra vendedor. A tela de
-- Fiado abre pro vendedor, mas `pagamentos` só tinha policy de ADMIN:
--   · gravar o recebimento dava "new row violates row-level security policy";
--   · ler o que o cliente já pagou devolvia VAZIO (sem erro), e a tela mostrava
--     "Já pagou R$ 0,00" pra quem tinha pago R$ 168 e R$ 68.
-- (Mesmo sintoma mudo das 4 camadas: a RLS é a quarta.)
--
-- Libera SÓ o recebimento de fiado — a linha com observação "Recebimento de
-- fiado", que é a que a tela grava. As demais linhas de `pagamentos` (mesa,
-- delivery, caixa) seguem só do admin, e o vendedor continua sem trocar a forma
-- nem apagar recebimento (UPDATE/DELETE ficam só com o admin).

drop policy if exists "Vendedor ve recebimentos de fiado" on public.pagamentos;
create policy "Vendedor ve recebimentos de fiado"
  on public.pagamentos for select
  using (
    (select current_perfil()) = 'vendedor'
    and empresa_id = (select current_empresa_id())
    and observacao = 'Recebimento de fiado'
  );

drop policy if exists "Vendedor registra recebimento de fiado" on public.pagamentos;
create policy "Vendedor registra recebimento de fiado"
  on public.pagamentos for insert
  with check (
    (select current_perfil()) = 'vendedor'
    and empresa_id = (select current_empresa_id())
    and observacao = 'Recebimento de fiado'
    and cliente_id is not null
    and valor > 0
  );
