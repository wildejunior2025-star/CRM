-- Migration 0282: mesa e comanda de balcão já vêm ligadas na loja nova
--
-- POR QUÊ
-- Toda loja que a gente abre é bar, lanchonete, conveniência, restaurante —
-- e todas atendem no balcão ou na mesa. Mesmo assim, `presencial_ativo` e
-- `comanda_balcao_ativa` nasciam FALSE, e alguém tinha que lembrar de ligar
-- os dois na mão em cada loja.
--
-- Em 24/09 isso apareceu montando a Branka: o dono abriu o Salão, viu as mesas
-- e não achou como lançar comanda avulsa. Não era bug — era
-- `comanda_balcao_ativa` desligada, o que não aparece em lugar nenhum da tela
-- de Salão. O Saidera e a Estação tinham as duas ligadas porque foram ligadas
-- uma vez, no passado.
--
-- Padrão que erra pra um lado só: loja que NÃO atende presencial desliga em
-- dois cliques e não perde nada. Loja que atende e não sabe que existe fica
-- sem recurso sem nunca descobrir por quê.
--
-- Vale pras PRÓXIMAS. As que já existem seguem como estão (ligar em loja que
-- só faz delivery poluiria o menu dela sem ninguém pedir) — as duas de hoje
-- são ligadas à parte, logo abaixo, porque o dono pediu.

ALTER TABLE public.empresas ALTER COLUMN presencial_ativo     SET DEFAULT true;
ALTER TABLE public.empresas ALTER COLUMN comanda_balcao_ativa SET DEFAULT true;

COMMENT ON COLUMN public.empresas.presencial_ativo IS
  'Salão/mesas no gestor. Liga por padrão desde a mig 0282: quase toda loja atende presencial.';
COMMENT ON COLUMN public.empresas.comanda_balcao_ativa IS
  'Comanda avulsa, sem mesa (balcão/viagem). Liga por padrão desde a mig 0282 — sem ela o Salão só deixa abrir comanda tocando numa mesa.';

-- As duas lojas abertas em 23-24/09, a pedido do dono.
UPDATE public.empresas
   SET presencial_ativo = true, comanda_balcao_ativa = true
 WHERE slug IN ('branka', 'lidy');
