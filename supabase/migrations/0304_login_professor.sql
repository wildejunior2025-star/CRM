-- =========================================================
-- Migration 0304 - Professor entra pelo telefone também
-- =========================================================
-- A área do professor é no celular, igual à do aluno: ele digita o telefone e
-- os 4 números. A busca do login passa a olhar também os profiles de
-- professor, não só a lista de alunos (mig 0298).
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
    -- alunos (pelo telefone da ficha ou pela matrícula)
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
    union
    -- professores
    select p.email
    from profiles p
    cross join alvo
    where p.perfil = 'professor'
      and length(alvo.digitos) >= 8
      and right(regexp_replace(coalesce(p.telefone, ''), '[^0-9]', '', 'g'), 8) = right(alvo.digitos, 8)
    limit 2
  )
  select case when (select count(*) from achados) = 1 then (select email from achados) end;
$$;

grant execute on function academia_email_do_aluno(text) to anon, authenticated;

-- O professor também troca a própria senha de 4 números (mig 0301 só deixava aluno).
create or replace function academia_trocar_minha_senha(p_senha text)
returns void
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_perfil text;
begin
  if p_senha !~ '^[0-9]{4}$' then
    raise exception 'A senha tem que ser de 4 números.';
  end if;

  select perfil into v_perfil from profiles where id = auth.uid();
  if v_perfil not in ('aluno', 'professor') then
    raise exception 'Só aluno e professor trocam a senha por aqui.';
  end if;

  update auth.users
     set encrypted_password = crypt(p_senha, gen_salt('bf')), updated_at = now()
   where id = auth.uid();
end;
$$;

grant execute on function academia_trocar_minha_senha(text) to authenticated;
