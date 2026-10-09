-- Mensalidade paga em duas formas (ex.: metade dinheiro, metade cartão).
-- Fica UM pagamento só — uma mensalidade — com as partes guardadas dentro.
-- Assim o total por forma no caixa sai certo sem contar a mensalidade duas
-- vezes, e cancelar o pagamento continua sendo uma operação só.
alter table academia_pagamentos
  add column if not exists partes jsonb;

comment on column academia_pagamentos.partes is
  'Pagamento em duas formas: [{"forma":"dinheiro","valor":30},{"forma":"cartao","valor":30}]. Quando tem partes, forma = ''dividido'' e valor e a soma.';
