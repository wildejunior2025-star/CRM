-- =========================================================
-- Migration 0301 - Aluno troca a própria senha (4 números)
-- =========================================================
-- A senha do aluno é um PIN de 4 números (é o teclado do login). O caminho
-- normal do Supabase exige 6 caracteres e recusava a troca; afrouxar essa
-- regra valeria pro sistema inteiro, inclusive pros lojistas.
--
-- Então a troca passa por aqui: só o próprio aluno, só 4 números.
-- =========================================================

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
  if v_perfil is distinct from 'aluno' then
    raise exception 'Só o aluno troca a senha por aqui.';
  end if;

  update auth.users
     set encrypted_password = crypt(p_senha, gen_salt('bf')), updated_at = now()
   where id = auth.uid();
end;
$$;

revoke all on function academia_trocar_minha_senha(text) from public, anon;
grant execute on function academia_trocar_minha_senha(text) to authenticated;

comment on function academia_trocar_minha_senha is
  'O aluno troca a própria senha de 4 números (o Supabase exige 6 no caminho normal) — mig 0301.';
