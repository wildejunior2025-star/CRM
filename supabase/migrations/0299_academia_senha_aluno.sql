-- =========================================================
-- Migration 0299 - Redefinir a senha do aluno pela recepção
-- =========================================================
-- O aluno não tem e-mail de verdade, então não existe "esqueci minha senha"
-- por e-mail. Quem resolve é a recepção: aperta o botão e a senha volta a ser
-- os 4 últimos dígitos do celular dele.
--
-- Só o dono/funcionário da MESMA academia pode fazer isso (confere pela
-- empresa do aluno contra a empresa de quem está logado).
-- =========================================================

create or replace function academia_resetar_senha(p_aluno_id uuid)
returns text
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_profile uuid;
  v_tel     text;
  v_senha   text;
begin
  select a.profile_id, regexp_replace(coalesce(a.telefone, ''), '[^0-9]', '', 'g')
    into v_profile, v_tel
  from academia_alunos a
  where a.id = p_aluno_id and a.empresa_id = current_empresa_id();

  if v_profile is null then
    raise exception 'Aluno sem conta de acesso ou de outra academia.';
  end if;
  if length(v_tel) < 4 then
    raise exception 'Cadastre o celular do aluno primeiro: a senha são os 4 últimos dígitos dele.';
  end if;

  v_senha := right(v_tel, 4);
  update auth.users
     set encrypted_password = crypt(v_senha, gen_salt('bf')), updated_at = now()
   where id = v_profile;

  return v_senha;
end;
$$;

revoke all on function academia_resetar_senha(uuid) from public, anon;
grant execute on function academia_resetar_senha(uuid) to authenticated;

comment on function academia_resetar_senha is
  'Recepção redefine a senha do aluno para os 4 últimos dígitos do celular dele (mig 0299).';
