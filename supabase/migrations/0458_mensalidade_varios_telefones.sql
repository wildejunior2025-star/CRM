-- Cobrança da mensalidade pra MAIS DE UM responsável (18/11/2026).
--
-- Até aqui a loja tinha um telefone só (zap_telefone). Em loja de sócios, ou
-- onde quem manda no dinheiro não é quem usa o sistema, a cobrança chegava pra
-- uma pessoa só e morria ali. Agora é uma lista.
--
-- zap_telefone fica como está e vira a PRIMEIRA da lista: assim nenhum envio
-- antigo quebra enquanto o código novo não estiver no ar em todo lugar.
alter table mensalidade_config
  add column if not exists zap_telefones text[];

-- Quem já tinha um número entra na lista com ele.
update mensalidade_config
   set zap_telefones = array[zap_telefone]
 where zap_telefones is null
   and coalesce(zap_telefone, '') <> '';
