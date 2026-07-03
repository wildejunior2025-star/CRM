-- CEP do endereço de entrega no pedido. Preenchido na venda de balcão do gestor
-- (com autofill via ViaCEP) e nos pedidos importados por print/PDF.
alter table pedidos_delivery add column if not exists endereco_cep text;
