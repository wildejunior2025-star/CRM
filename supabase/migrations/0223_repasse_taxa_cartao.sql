-- =========================================================
-- 0223: crédito/débito na Loja Online e repasse da taxa
-- =========================================================
-- No balcão a loja já cobra a mais de quem paga no crédito — a maquineta come
-- uma % e o preço do cardápio não cabe esse desconto. Pelo link, o cliente
-- escolhia só "Cartão" e pagava o mesmo preço do dinheiro: a loja bancava a
-- taxa sem perceber.
--
-- Agora crédito e débito aparecem separados no checkout (já existiam como forma
-- de pagamento desde 10/08) e cada um pode ter um acréscimo próprio, cobrado do
-- cliente. Ex.: CD Bom com crédito 5% e débito sem taxa.
--
-- Isto é o REPASSE (o que o cliente paga a mais), e não se confunde com
-- `taxa_credito_pct`/`taxa_debito_pct`, que é o que a maquineta desconta da
-- loja e alimenta o "cai na conta" do Caixa. Os dois números costumam ser
-- diferentes: a loja repassa 5% de uma máquina que cobra 3%, ou repassa nada.
--
-- 0 = sem acréscimo, que é como toda loja começa.
-- =========================================================

ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS repasse_credito_pct numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repasse_debito_pct  numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repasse_cartao_pct  numeric(5,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.empresas.repasse_credito_pct IS
  'Acrescimo (%) cobrado do cliente que paga no credito pela Loja Online. Diferente de taxa_credito_pct, que e o que a maquineta desconta da loja.';

ALTER TABLE public.pedidos_delivery
  ADD COLUMN IF NOT EXISTS acrescimo numeric(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.pedidos_delivery.acrescimo IS
  'Acrescimo da forma de pagamento (taxa do cartao repassada). Ja esta dentro de total.';
