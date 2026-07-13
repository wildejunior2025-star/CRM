-- Rodapé configurável da comanda da COZINHA (ex.: frase/versículo do dono).
-- Sai no fim da comanda que vai pra cozinha; se null, não imprime nada.
alter table public.empresas add column if not exists rodape_cozinha text;

-- Restaurante do Irmão pediu a frase dele na comanda da cozinha.
update public.empresas
   set rodape_cozinha = 'Ate aqui nos ajudou o Senhor. 1 Samuel 7-12'
 where id = '4011dbb8-32dd-45e3-ba7e-d65aac5108e4';
