-- Rachar a conta em partes IGUAIS gerava um QR só.
--
-- A cobrança de cada parte era identificada pelo VALOR — no servidor, pra não
-- repetir QR em toque duplo no botão; e na tela, pra saber qual QR é de qual
-- linha. Com "R$ 16,50 + R$ 16,50" as duas partes são o mesmo valor, então a
-- segunda reaproveitava a primeira: duas pessoas, um QR só, e a mesa pagando
-- metade da conta.
--
-- Agora cada parte tem número próprio. Sem `parte` (a cobrança da conta inteira,
-- e todas as antigas) o comportamento continua o de antes.
alter table comanda_pix_cobrancas add column if not exists parte smallint;

comment on column comanda_pix_cobrancas.parte is
  'Número da parte quando a conta é rachada (0,1,2...). Nulo = cobrança da conta inteira. É o que distingue duas partes de mesmo valor.';
