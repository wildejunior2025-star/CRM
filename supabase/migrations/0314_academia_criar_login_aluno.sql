-- Cria a conta do app pra um aluno que ainda não tem.
--
-- As 309 contas da importação foram feitas UMA VEZ, na mão, por SQL. Quem foi
-- cadastrado no balcão depois disso ficava sem login: entrava na catraca e
-- não entrava no app — e ninguém percebia, porque nada reclama. Em 12/10 eram
-- 29 alunos ativos nessa situação, 24 deles já com o rosto cadastrado.
--
-- Esta função repete aquele molde pra poder ser chamada sempre que nasce um
-- aluno (o formulário chama sozinho) e também pra consertar os antigos (botão
-- "Criar login do app" na tela de edição).
--
-- Senha: 4 últimos dígitos do celular; sem celular, 4 últimos da matrícula.
-- A API normal do Supabase exige 6 caracteres, por isso a senha é gravada
-- direto aqui com crypt — igual às 309. E o pgcrypto do Supabase mora no
-- schema `extensions`, daí o prefixo.
--
-- Aluno sem matrícula (cadastrado à mão) ganha uma na faixa 9000+, que o
-- sistema antigo nunca usou, porque a matrícula é a chave do e-mail interno.
create or replace function academia_criar_login(p_aluno uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a            academia_alunos%rowtype;
  v_chave      text;
  v_email      text;
  v_senha      text;
  v_id         uuid := gen_random_uuid();
  v_fone       text;
begin
  select * into a from academia_alunos where id = p_aluno;
  if not found then return jsonb_build_object('ok', false, 'erro', 'aluno nao encontrado'); end if;

  -- Cria conta de login: só quem manda na academia DAQUELE aluno.
  if not exists (
    select 1 from profiles p
    where p.id = auth.uid()
      and p.empresa_id = a.empresa_id
      and p.perfil in ('admin', 'super_admin', 'professor')
  ) then
    return jsonb_build_object('ok', false, 'erro', 'sem permissao');
  end if;

  if a.profile_id is not null then return jsonb_build_object('ok', false, 'erro', 'ja tem login'); end if;

  v_chave := nullif(trim(coalesce(a.matricula, '')), '');
  if v_chave is null then
    select coalesce(max(matricula::bigint), 8999) + 1 into v_chave
    from academia_alunos
    where empresa_id = a.empresa_id and matricula ~ '^[0-9]+$' and matricula::bigint >= 9000;
    update academia_alunos set matricula = v_chave where id = a.id;
  end if;

  v_email := v_chave || '@aluno.fwcinter.com';
  if exists (select 1 from auth.users where email = v_email) then
    return jsonb_build_object('ok', false, 'erro', 'e-mail ja existe: ' || v_email);
  end if;

  v_fone := regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g');
  v_senha := case when length(v_fone) >= 4 then right(v_fone, 4) else right(v_chave, 4) end;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
    v_email, extensions.crypt(v_senha, extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('nome', a.nome, 'tipo_cadastro', 'aluno'),
    '', '', '', ''
  );

  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (v_id::text, v_id,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          'email', now(), now());

  insert into profiles (id, perfil, empresa_id, nome, email, username, telefone)
  values (v_id, 'aluno', a.empresa_id, a.nome, v_email,
          case when length(v_chave) between 3 and 30 then v_chave else null end,
          nullif(v_fone, ''))
  on conflict (id) do update set perfil = 'aluno', empresa_id = excluded.empresa_id;

  update academia_alunos set profile_id = v_id where id = a.id;

  return jsonb_build_object('ok', true, 'matricula', v_chave, 'email', v_email, 'senha', v_senha);
end $$;

grant execute on function academia_criar_login(uuid) to authenticated;
