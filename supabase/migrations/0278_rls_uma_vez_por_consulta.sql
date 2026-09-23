-- Migration 0278: a RLS para de reler `profiles` linha por linha
--
-- O QUE QUEBROU
-- Em 23/09/2026, por volta das 10h40, o sistema inteiro parou: o gestor não
-- abria, o link do ponto de entrega não abria, a loja não conseguia cancelar
-- pedido. O banco estava vivo (aceitava conexão em 0,07s) mas a API de dados
-- não devolvia um byte sequer. O alerta do painel dizia "Disk IO budget is
-- being consumed": o crédito de disco do projeto tinha acabado.
--
-- QUEM COMEU O DISCO
-- Nos 6 minutos seguintes ao restart, com o movimento já baixo:
--
--     profiles ................ 287.833 leituras
--     produtos ...................... 495
--     pedidos_delivery .............. 176
--     empresas ...................... 133
--
-- A tabela de usuários lida 1.600x mais que a de pedidos. `profiles` não é
-- tabela de trabalho — ela só aparece aí porque TODA policy chama
-- current_perfil() / current_empresa_id(), e essas funções fazem
-- `select ... from profiles`. Escritas soltas no predicado, elas rodam UMA VEZ
-- POR LINHA examinada.
--
-- pedidos_delivery tem 14 policies. Uma consulta de 100 pedidos avalia
-- 100 linhas x ~6 policies de SELECT x 2 funções = ~1.200 idas a `profiles`
-- para devolver 100 pedidos.
--
-- O CONSERTO
-- Envolver a chamada em `(select ...)`. Isso a transforma em InitPlan: o
-- Postgres resolve UMA VEZ por consulta e reusa o valor em todas as linhas.
-- Mesma regra, mesma segurança, mesmo resultado — só para de reler o óbvio.
-- É a forma que a própria documentação do Supabase recomenda, e é o que o
-- alerta "Auth RLS Initialization Plan" está pedindo.
--
-- Nada aqui afrouxa permissão: cada USING/WITH CHECK abaixo é o texto que já
-- estava no banco, com as chamadas envolvidas em subselect e nada mais.
--
-- Esta migration cobre pedidos_delivery, a tabela mais cara do sistema
-- (4.512s de CPU acumulada em 43 mil consultas, 104ms cada). As demais vêm
-- depois, medindo o efeito desta primeiro.

-- Se a tabela estiver ocupada, desiste em vez de virar fila na hora do almoço.
SET lock_timeout = '5s';

BEGIN;

-- ── ALL ──────────────────────────────────────────────────────────────────────
ALTER POLICY "Admin gerencia pedidos da propria empresa" ON public.pedidos_delivery
  USING      (((select current_perfil()) = 'admin') AND (empresa_id = (select current_empresa_id())))
  WITH CHECK (((select current_perfil()) = 'admin') AND (empresa_id = (select current_empresa_id())));

ALTER POLICY "Super admin gerencia todos os pedidos delivery" ON public.pedidos_delivery
  USING      ((select current_perfil()) = 'super_admin')
  WITH CHECK ((select current_perfil()) = 'super_admin');

ALTER POLICY "Vendedor gerencia pedidos da propria empresa" ON public.pedidos_delivery
  USING      (((select current_perfil()) = 'vendedor') AND (empresa_id = (select current_empresa_id())))
  WITH CHECK (((select current_perfil()) = 'vendedor') AND (empresa_id = (select current_empresa_id())));

-- ── SELECT ───────────────────────────────────────────────────────────────────
ALTER POLICY "Cliente ve seus pedidos" ON public.pedidos_delivery
  USING (user_id = (select auth.uid()));

ALTER POLICY "Cliente ve seus pedidos delivery" ON public.pedidos_delivery
  USING (cliente_id IN (SELECT clientes.id FROM clientes WHERE clientes.user_id = (select auth.uid())));

ALTER POLICY "Cozinheiro ve pedidos delivery da loja" ON public.pedidos_delivery
  USING (((select current_perfil()) = 'cozinheiro') AND (empresa_id = (select current_empresa_id())));

ALTER POLICY "Entregador ve seus pedidos" ON public.pedidos_delivery
  USING (((select current_perfil()) = 'entregador')
         AND (empresa_id = (select current_empresa_id()))
         AND ((entregador_id = (select auth.uid()))
              OR ((entregador_id IS NULL)
                  AND ((status = ANY (ARRAY['confirmado'::text, 'em_preparo'::text, 'pronto'::text]))
                       OR ((origem = 'ifood') AND (status = 'saiu_entrega'))))));

ALTER POLICY "Usuario ve pedido pelo user_id" ON public.pedidos_delivery
  USING (user_id = (select auth.uid()));

-- ── UPDATE ───────────────────────────────────────────────────────────────────
ALTER POLICY "Admin atualiza pedido delivery" ON public.pedidos_delivery
  USING      ((((select current_perfil()) = 'admin') AND (empresa_id = (select current_empresa_id())))
              OR ((select current_perfil()) = 'super_admin'))
  WITH CHECK ((((select current_perfil()) = 'admin') AND (empresa_id = (select current_empresa_id())))
              OR ((select current_perfil()) = 'super_admin'));

ALTER POLICY "Cozinheiro atualiza status delivery" ON public.pedidos_delivery
  USING      (((select current_perfil()) = 'cozinheiro') AND (empresa_id = (select current_empresa_id())))
  WITH CHECK (((select current_perfil()) = 'cozinheiro') AND (empresa_id = (select current_empresa_id())));

ALTER POLICY "Entregador atualiza seus pedidos" ON public.pedidos_delivery
  USING      (((select current_perfil()) = 'entregador')
              AND (empresa_id = (select current_empresa_id()))
              AND ((entregador_id = (select auth.uid()))
                   OR ((entregador_id IS NULL)
                       AND ((status = ANY (ARRAY['confirmado'::text, 'em_preparo'::text, 'pronto'::text]))
                            OR ((origem = 'ifood') AND (status = 'saiu_entrega'))))))
  WITH CHECK (((select current_perfil()) = 'entregador')
              AND (empresa_id = (select current_empresa_id()))
              AND ((entregador_id = (select auth.uid()))
                   OR ((entregador_id IS NULL)
                       AND ((status = ANY (ARRAY['confirmado'::text, 'em_preparo'::text, 'pronto'::text]))
                            OR ((origem = 'ifood') AND (status = 'saiu_entrega'))))));

COMMIT;
