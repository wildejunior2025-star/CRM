-- O CPF/CNPJ do cliente que saiu NA NOTA. O cupom impresso so sabia o que vinha
-- da propria linha de nfce_notas, que nao guardava isso: a nota ia pra SEFAZ com
-- o documento certo e o papel saia "CONSUMIDOR NAO IDENTIFICADO".
alter table public.nfce_notas
  add column if not exists destinatario_doc text;

comment on column public.nfce_notas.destinatario_doc is
  'So digitos: 11 = CPF, 14 = CNPJ do consumidor identificado na nota. Null = nao identificado.';

-- Nota 10 da Agv (26/10): saiu com o CNPJ 09390295000205 (conferido no XML).
update public.nfce_notas set destinatario_doc = '09390295000205'
 where numero = 10 and serie = 10 and ambiente = 'producao'
   and empresa_id = 'febc3db3-1b04-4cdc-a22f-119db381fbeb' and destinatario_doc is null;
