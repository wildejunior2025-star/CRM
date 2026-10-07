-- =========================================================
-- Migration 0298 - Aluno entra pelo TELEFONE
-- =========================================================
-- Matrícula ninguém decora (o usuário, 07/10/2026). O aluno digita o telefone
-- dele (ou o e-mail, quando tiver) e esta função devolve o e-mail interno da
-- conta — o mesmo caminho que o apelido já usava no login das lojas.
--
-- Casa pelos últimos 8 dígitos: resolve DDD digitado ou não e o nono dígito.
-- Se dois alunos tiverem o mesmo telefone (marido e mulher, por exemplo),
-- devolve nulo de propósito: aí a recepção resolve, em vez de abrir a conta
-- de outra pessoa.
-- =========================================================

create or replace function academia_email_do_aluno(p_busca text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  with alvo as (
    select regexp_replace(coalesce(p_busca, ''), '[^0-9]', '', 'g') as digitos
  ),
  achados as (
    select p.email
    from academia_alunos a
    join profiles p on p.id = a.profile_id
    cross join alvo
    where alvo.digitos <> ''
      and (
        (length(alvo.digitos) >= 8
          and right(regexp_replace(coalesce(a.telefone, ''), '[^0-9]', '', 'g'), 8) = right(alvo.digitos, 8))
        or a.matricula = alvo.digitos
      )
    limit 2
  )
  select case when (select count(*) from achados) = 1 then (select email from achados) end;
$$;

grant execute on function academia_email_do_aluno(text) to anon, authenticated;

comment on function academia_email_do_aluno is
  'Telefone (ou matrícula) do aluno → e-mail interno da conta dele, pro login da academia (mig 0298).';
