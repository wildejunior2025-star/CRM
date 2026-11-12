-- Quem ganha telefone ganha conta no app, e o aluno vence o professor na busca.
--
-- (Aplicado no banco como 0326 e 0327; numerado aqui pela sequencia do repo.)
--
-- O instrutor trocou o numero de uma aluna pra ela conseguir entrar e nao
-- adiantou: ela nao tinha CONTA. A tela dizia "nao achei esse telefone", que
-- parece erro de numero — e ele trocou o numero de novo. Eram 34 alunos assim,
-- todos da importacao de 09/10: telefone na ficha e nenhuma conta.
--
-- A criacao da conta so acontecia no cadastro NOVO. Agora acontece tambem
-- quando a ficha ganha o telefone, que e o momento em que o aluno passa a ter
-- como entrar.

-- O miolo da criacao, sem a checagem de permissao: quem chama ja teve
-- permissao pra gravar na ficha do aluno.
create or replace function public.academia_criar_login_interno(p_aluno uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  a       academia_alunos%rowtype;
  v_chave text;
  v_email text;
  v_senha text;
  v_id    uuid := gen_random_uuid();
  v_fone  text;
begin
  select * into a from academia_alunos where id = p_aluno;
  if not found then return jsonb_build_object('ok', false, 'erro', 'aluno nao encontrado'); end if;
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

-- A funcao que a tela chama continua checando quem pediu.
create or replace function public.academia_criar_login(p_aluno uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare a_empresa uuid;
begin
  select empresa_id into a_empresa from academia_alunos where id = p_aluno;
  if a_empresa is null then return jsonb_build_object('ok', false, 'erro', 'aluno nao encontrado'); end if;

  if not exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.empresa_id = a_empresa
      and p.perfil in ('admin', 'super_admin', 'professor')
  ) then
    return jsonb_build_object('ok', false, 'erro', 'sem permissao');
  end if;

  return academia_criar_login_interno(p_aluno);
end $$;

-- O gatilho do telefone agora tambem CRIA a conta de quem ainda nao tem.
create or replace function public.academia_senha_segue_telefone()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_fone text := regexp_replace(coalesce(new.telefone, ''), '\D', '', 'g');
begin
  if length(v_fone) < 4 then
    return new;
  end if;

  -- Sem conta: ganha uma agora, com a senha ja certa.
  if new.profile_id is null then
    perform academia_criar_login_interno(new.id);
    return new;
  end if;

  -- So quando o telefone mudou de verdade (ou o aluno acabou de ganhar conta).
  if tg_op = 'UPDATE'
     and regexp_replace(coalesce(old.telefone, ''), '\D', '', 'g') = v_fone
     and old.profile_id is not distinct from new.profile_id then
    return new;
  end if;

  update auth.users u
     set encrypted_password = extensions.crypt(right(v_fone, 4), extensions.gen_salt('bf')),
         updated_at = now()
   where u.id = new.profile_id
     and u.last_sign_in_at is null;  -- quem ja entrou tem senha propria

  return new;
end $$;

revoke all on function public.academia_criar_login_interno(uuid) from public, anon, authenticated;

-- Quando o mesmo telefone e de um aluno E de um professor, vale o ALUNO.
--
-- O instrutor esta cadastrado como aluno tambem, com o mesmo numero. A busca
-- juntava os dois, via "achei 2" e devolvia nada: a tela dizia "nao achei esse
-- telefone", como se o numero estivesse errado. Professor entra pelo e-mail; o
-- telefone e o caminho do aluno, entao o aluno ganha.
create or replace function public.academia_email_do_aluno(p_busca text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  with alvo as (
    select regexp_replace(coalesce(p_busca, ''), '[^0-9]', '', 'g') as digitos
  ),
  alunos as (
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
  ),
  professores as (
    select p.email
    from profiles p
    cross join alvo
    where p.perfil = 'professor'
      and length(alvo.digitos) >= 8
      and right(regexp_replace(coalesce(p.telefone, ''), '[^0-9]', '', 'g'), 8) = right(alvo.digitos, 8)
    limit 2
  )
  select coalesce(
    (select case when (select count(*) from alunos) = 1 then (select email from alunos) end),
    (select case when (select count(*) from alunos) = 0
                  and (select count(*) from professores) = 1
                 then (select email from professores) end)
  );
$$;
