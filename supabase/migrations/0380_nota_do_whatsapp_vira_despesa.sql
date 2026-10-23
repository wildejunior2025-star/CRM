-- A nota que entra no estoque tambem e uma DESPESA (23/10/2026)
--
-- Ate agora a foto da nota virava so movimento de estoque. A compra nao
-- chegava no financeiro, entao a loja comprava R$ 245,60 de carne e o lucro
-- do dia seguia como se nada tivesse saido do caixa.
--
-- `nota` guarda o que o robo leu do documento (fornecedor, CNPJ, total, data,
-- se foi pago e a forma) pra mostrar na confirmacao antes do SIM.
-- `conta_id` e a conta criada, pra o DESFAZER levar ela junto com os
-- movimentos de estoque -- senao desfazer deixaria a despesa orfa.
alter table public.estoque_whatsapp
  add column if not exists nota     jsonb,
  add column if not exists conta_id uuid references public.contas_financeiras(id) on delete set null;
