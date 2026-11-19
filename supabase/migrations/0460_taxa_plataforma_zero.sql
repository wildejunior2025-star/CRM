-- A TAXA DE PLATAFORMA NAO EXISTE (19/11/2026)
--
-- A coluna `empresas.taxa_plataforma` nasceu valendo 5% e foi aplicada em
-- TODAS as lojas (so o Zebu tinha sido zerado na mao). Ela foi criada na epoca
-- em que a ideia era a FWC ficar com uma porcentagem das vendas de um
-- aplicativo proprio. Esse aplicativo nunca entrou no ar, e a cobranca da FWC
-- virou mensalidade: a CDBom, por exemplo, paga R$ 199/mes pelo plano basico.
--
-- Resultado: a tela de Pedidos vinha mostrando pro dono um "Liquido" 5% menor
-- que o faturamento real. Na CDBom isso deu R$ 1.437,54 descontados em 30 dias
-- contra R$ 199 que ela paga de verdade -- e pior, descontava ate em cima da
-- taxa de entrega (R$ 108,35 no periodo), que e dinheiro do motoboy, e em cima
-- de venda em dinheiro e PIX na entrega, onde a FWC nao encosta no dinheiro.
--
-- Zera todo mundo e muda o padrao pra 0, senao a proxima loja criada nasce
-- de novo com os 5%. O campo CONTINUA existindo e editavel no Super ADM: se um
-- dia o modelo de porcentagem voltar, e so pôr o valor na loja que usar.
--
-- Nao mexe em nada de iFood: la o liquido vem da API financeira do iFood, com
-- comissao e taxa de transacao de verdade.

alter table empresas alter column taxa_plataforma set default 0;

update empresas set taxa_plataforma = 0 where coalesce(taxa_plataforma, 0) <> 0;
