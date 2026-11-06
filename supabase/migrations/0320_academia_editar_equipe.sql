-- Editar quem ja tem login: nome, WhatsApp, e-mail de entrada, o que a pessoa
-- faz, e a senha.
--
-- A tela da Equipe so sabia CRIAR. Quem errava o e-mail na hora de cadastrar
-- (aconteceu: "edsonpereira@100hotmail.com" no lugar de
-- "edsonpereira100@hotmail.com") ficava com a conta errada pra sempre, porque
-- mexer em auth.users nao da pelo site. Dava pra criar outra conta e abandonar
-- a torta, mas ai sobra lixo e ninguem sabe qual e a boa.
--
-- Security definer porque so o dono do banco escreve em auth.users; a funcao
-- confere que quem chamou e admin DA MESMA EMPRESA do editado.
create or replace function public.academia_editar_equipe(
  p_id       uuid,
  p_nome     text default null,
  p_email    text default null,
  p_telefone text default null,
  p_perfil   text default null,
  p_senha    text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  alvo   profiles%rowtype;
  v_mail text := lower(nullif(trim(p_email), ''));
begin
  select * into alvo from profiles where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'Pessoa não encontrada.');
  end if;

  -- Quem chamou precisa ser admin da mesma empresa.
  if not exists (
    select 1 from profiles eu
    where eu.id = auth.uid()
      and eu.empresa_id = alvo.empresa_id
      and eu.perfil in ('admin', 'super_admin')
  ) then
    return jsonb_build_object('ok', false, 'erro', 'Só o dono da academia pode editar a equipe.');
  end if;

  -- Ninguem mexe num super_admin por aqui.
  if alvo.perfil = 'super_admin' then
    return jsonb_build_object('ok', false, 'erro', 'Esta conta não pode ser editada por aqui.');
  end if;

  if p_perfil is not null and p_perfil not in ('admin', 'professor') then
    return jsonb_build_object('ok', false, 'erro', 'Acesso inválido.');
  end if;

  if v_mail is not null then
    if v_mail !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      return jsonb_build_object('ok', false, 'erro', 'Esse e-mail não parece certo.');
    end if;
    if exists (select 1 from auth.users where lower(email) = v_mail and id <> p_id) then
      return jsonb_build_object('ok', false, 'erro', 'Já existe uma conta com esse e-mail.');
    end if;
    update auth.users set email = v_mail, updated_at = now() where id = p_id;
    update auth.identities
       set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(v_mail)),
           updated_at = now()
     where user_id = p_id and provider = 'email';
  end if;

  if p_senha is not null and p_senha <> '' then
    if length(p_senha) < 6 then
      return jsonb_build_object('ok', false, 'erro', 'A senha precisa de pelo menos 6 letras ou números.');
    end if;
    update auth.users
       set encrypted_password = extensions.crypt(p_senha, extensions.gen_salt('bf')),
           updated_at = now()
     where id = p_id;
  end if;

  update profiles
     set nome     = coalesce(nullif(trim(p_nome), ''), nome),
         telefone = case when p_telefone is null then telefone
                         else nullif(trim(p_telefone), '') end,
         perfil   = coalesce(p_perfil, perfil),
         email    = coalesce(v_mail, email)
   where id = p_id;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.academia_editar_equipe(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.academia_editar_equipe(uuid, text, text, text, text, text) to authenticated;
