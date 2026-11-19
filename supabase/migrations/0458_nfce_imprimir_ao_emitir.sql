-- Imprimir o cupom da NFC-e na termica logo depois de emitir (18/11/2026, CDBom)
--
-- Hoje, quando alguem emite a nota por uma tela (Vendas > Delivery, Notas Fiscais,
-- venda da mesa), o cupom sai na termica na hora. A CDBom emite quase tudo pela nota
-- automatica (que nunca imprime) e quer poder desligar esse papel. Ligado por padrao:
-- as outras lojas continuam como estao.
alter table public.empresa_fiscal
  add column if not exists nfce_imprimir_ao_emitir boolean not null default true;

comment on column public.empresa_fiscal.nfce_imprimir_ao_emitir is
  'Se false, a emissao manual da NFC-e nao manda o cupom pra termica. Reimprimir pelo botao continua funcionando.';
