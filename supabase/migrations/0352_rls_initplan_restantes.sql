-- Migration 0352: termina o conserto do "Auth RLS Initialization Plan" (mig 0279)
--
-- A 0279 envolveu current_perfil()/current_empresa_id() em (select ...) nas
-- policies que existiam em 23/09. Policies criadas depois (academia_*, caixa_dia,
-- entregador_valor_ajustes, comanda_eventos, monitor_whatsapp) ficaram sem:
-- a função roda uma vez por LINHA examinada, em vez de uma vez por consulta.
-- Mesma regra, mesma segurança — só muda quando a função é avaliada.
--
-- Mesmo método da 0279: lê a policy de pg_policies, envolve as chamadas por
-- regexp e remonta com format(%I). Nada digitado à mão.
-- lock_timeout: ALTER POLICY pede ACCESS EXCLUSIVE; sem limite, vira fila e
-- trava a loja. Se não conseguir a trava em 10s, a migration falha inteira e
-- dá pra repetir.

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  p record;
  usando text; checando text; sql text; n int := 0;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND coalesce(qual,'') || coalesce(with_check,'') ~* 'current_(perfil|empresa_id)\('
       AND coalesce(qual,'') || coalesce(with_check,'') !~* 'select\s+(public\.)?current_'
  LOOP
    usando   := regexp_replace(p.qual,       'current_(perfil|empresa_id)\(\)', '(SELECT current_\1())', 'g');
    checando := regexp_replace(p.with_check, 'current_(perfil|empresa_id)\(\)', '(SELECT current_\1())', 'g');

    sql := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    IF usando   IS NOT NULL THEN sql := sql || ' USING (' || usando || ')'; END IF;
    IF checando IS NOT NULL THEN sql := sql || ' WITH CHECK (' || checando || ')'; END IF;

    EXECUTE sql;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'policies ajustadas: %', n;
END $$;
