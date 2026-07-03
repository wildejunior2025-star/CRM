-- Nome do responsável pela loja (dono), editável na aba Conta da Minha Loja.
-- CPF/CNPJ, telefone e e-mail de contato já existem (cnpj, telefone_contato, email_contato).
alter table empresas add column if not exists nome_responsavel text;
