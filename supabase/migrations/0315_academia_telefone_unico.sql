-- Um telefone, um aluno.
--
-- O telefone é a chave de entrada do aluno no app: a função de login procura
-- pelos 8 últimos dígitos. Com o número repetido ela não sabe de quem é a
-- conta e, por segurança, não deixa NINGUÉM entrar — os dois ficam de fora e
-- só conseguem pela matrícula, que ninguém decora. Em 12/10 havia 11 números
-- repetidos (4 com os dois alunos ativos), quase todos família dividindo o
-- mesmo celular.
--
-- Decisão do dono: não pode existir número repetido; família que divide
-- celular deixa o número em um só, e o outro entra pela matrícula.
--
-- Compara pelos 8 últimos dígitos de propósito: 84 99999-8888, (84)999998888
-- e 999998888 são o mesmo telefone pro login, então também são o mesmo aqui.
create unique index if not exists academia_alunos_telefone_idx
  on academia_alunos (
    empresa_id,
    right(regexp_replace(telefone, '\D', '', 'g'), 8)
  )
  where telefone is not null
    and length(regexp_replace(telefone, '\D', '', 'g')) >= 8;
