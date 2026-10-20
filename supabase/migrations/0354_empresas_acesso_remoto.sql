-- Acesso remoto ao PC da loja (20/10/2026)
--
-- Depois do travamento da impressora do Braseiro, instalamos o RustDesk no PC
-- de la. Cada maquina ganha um ID de 9 digitos que nao muda; sem guardar esse
-- numero em algum lugar, ele se perde num papel e o acesso remoto nao serve
-- pra nada na hora do aperto.
--
-- Fica na empresa (e nao numa tabela nova) porque e UM numero por loja e quem
-- consulta e o Super ADM, que ja carrega a empresa inteira.
alter table public.empresas
  add column if not exists rustdesk_id text;

comment on column public.empresas.rustdesk_id is
  'ID do RustDesk do PC da loja, pra suporte remoto. So o Super ADM le/escreve.';
