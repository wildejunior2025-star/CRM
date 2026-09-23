-- Migration 0279: o resto da RLS para de reler `profiles` linha por linha
--
-- Continuação da 0278, que cobriu só `pedidos_delivery`. Esta cobre as outras
-- 170 policies, em 96 tabelas.
--
-- POR QUE
-- Medido em 2h de movimento normal (23/09/2026, 12h→14h), DEPOIS da 0278:
--
--     profiles ............... 1.083.383 leituras
--     complemento_grupos ......... 17.311
--     produtos .................... 7.720
--     pedidos_delivery ............ 5.359
--     todo o resto somado ........ ~13.000
--
-- A tabela de usuários sozinha é 96% de tudo que o banco lê. E o trabalho útil
-- dessas 2h foi 28 pedidos, 45 itens de comanda e 265 mensagens: ~38 mil
-- consultas a `profiles` POR PEDIDO processado.
--
-- Causa: `current_perfil()` / `current_empresa_id()` fazem
-- `select ... from profiles`. Soltas no predicado, rodam uma vez por LINHA
-- examinada. `(select ...)` vira InitPlan e resolve uma vez por CONSULTA.
-- Mesma regra, mesma segurança. É o que o aviso "Auth RLS Initialization Plan"
-- do painel pede.
--
-- COMO FOI APLICADO
-- O texto novo NÃO foi digitado à mão: um DO block leu cada policy do próprio
-- catálogo (`pg_policies`), envolveu as chamadas via regexp e remontou o
-- ALTER POLICY com `format(%I)`. Sem transcrição, sem erro de digitação.
-- Também envolve `auth.uid()` e `auth.role()`, pelo mesmo motivo.
--
-- O filtro pula quem já está corrigido (`!~ 'SELECT (current_perfil|...)'`),
-- então rodar de novo é inofensivo.
--
-- `profiles` e `empresas` ficaram para um segundo lote, aplicado depois de o
-- primeiro passar na validação: são as que derrubam o login se saírem erradas.
--
-- VALIDAÇÃO (contagem de linhas visíveis, antes x depois)
--   admin       produtos=129  clientes=480  compl=15/261  caixas=6  comandas=21
--   cozinheiro  produtos=129  clientes=0    comandas=21   pedidos=5319
--   anon        produtos=4720 compl=49/525  empresas=7    categorias=94
-- Todos idênticos. Login conferido: admin e cozinheiro leem o próprio perfil.
--
-- `SET lock_timeout` é obrigatório: ALTER POLICY pega ACCESS EXCLUSIVE e sem
-- isso vira fila na hora do movimento. O bloco engole falha individual para
-- que uma tabela ocupada não aborte o lote inteiro.

SET lock_timeout = '8s';

DO $$
DECLARE r record; s text; q text; c text; ok int := 0; falhou int := 0; erros text := '';
BEGIN
  FOR r IN
    SELECT tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname='public'
      AND (coalesce(qual,'')||coalesce(with_check,'')) ~ '(current_perfil|current_empresa_id|current_cliente_id|auth\.uid|auth\.role)\(\)'
      AND (coalesce(qual,'')||coalesce(with_check,'')) !~ 'SELECT (current_perfil|current_empresa_id|current_cliente_id|auth\.)'
    ORDER BY tablename, policyname
  LOOP
    q := regexp_replace(regexp_replace(r.qual,
           '(current_perfil|current_empresa_id|current_cliente_id)\(\)','( SELECT \1())','g'),
           '(auth\.(uid|role))\(\)','( SELECT \1())','g');
    c := regexp_replace(regexp_replace(r.with_check,
           '(current_perfil|current_empresa_id|current_cliente_id)\(\)','( SELECT \1())','g'),
           '(auth\.(uid|role))\(\)','( SELECT \1())','g');

    s := format('ALTER POLICY %I ON public.%I', r.policyname, r.tablename);
    IF q IS NOT NULL THEN s := s || format(' USING (%s)', q); END IF;
    IF c IS NOT NULL THEN s := s || format(' WITH CHECK (%s)', c); END IF;

    BEGIN
      EXECUTE s;
      ok := ok + 1;
    EXCEPTION WHEN OTHERS THEN
      falhou := falhou + 1;
      erros := erros || r.tablename || '.' || r.policyname || ' -> ' || SQLERRM || ' | ';
    END;
  END LOOP;

  RAISE NOTICE 'policies corrigidas=% falharam=% %', ok, falhou, erros;
END $$;
