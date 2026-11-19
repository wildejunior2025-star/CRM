-- Endereco do emitente na NFC-e, separado do endereco da loja (19/11/2026, CDBom)
--
-- A CDBom emite pelo CNPJ da fabrica (Rua General Adjer Barreto, 178), mas a loja onde
-- o cliente compra e na Rua Santo Antonio, 12. O endereco da loja (empresas) segue
-- aparecendo no cardapio, no cupom de pedido etc.; so a nota usa o do emitente.
-- Vazio = usa o endereco da loja (todas as outras lojas).
alter table public.empresa_fiscal
  add column if not exists emitente_endereco text,
  add column if not exists emitente_numero text,
  add column if not exists emitente_bairro text,
  add column if not exists emitente_cep text;

update public.empresa_fiscal
   set emitente_endereco = 'Rua General Adjer Barreto',
       emitente_numero = '178',
       emitente_bairro = 'Novo Amarante',
       emitente_cep = '59296277'
 where empresa_id = 'a95b716b-d973-42ab-ace9-dae0fd1acd62'; -- Sorveteria CDBom
