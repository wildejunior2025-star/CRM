-- Trava de classificação fiscal por loja (18/11/2026, CDBom)
--
-- Sem NCM no cadastro do produto, a emissão usa o NCM/CFOP padrão da loja. Na CDBom o
-- padrão é o de sorvete fabricado (2105.00.10 / 5102 / 102): um item de revenda ainda
-- sem classificação (polpa, cobertura, casquinha) sairia na nota com dado errado.
-- Com esta opção ligada, a nota NÃO sai se algum item não tiver NCM no cadastro; o
-- pedido fica pendente de classificação (sem nota errada, sem alerta repetido).
-- Desligada por padrão: as outras lojas continuam usando o padrão da loja.
alter table public.empresa_fiscal
  add column if not exists exigir_ncm_produto boolean not null default false;

comment on column public.empresa_fiscal.exigir_ncm_produto is
  'Se true, a NFC-e só sai quando todos os itens têm NCM no cadastro do produto (nunca usa o NCM padrão da loja).';

update public.empresa_fiscal
   set exigir_ncm_produto = true
 where empresa_id = 'a95b716b-d973-42ab-ace9-dae0fd1acd62'; -- Sorveteria CDBom
