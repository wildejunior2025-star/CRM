-- O instrutor conferindo o contato e a senha do aluno, SEM ver o telefone.
--
-- O professor monta o treino com o aluno na frente dele, e e ali que aparece
-- "nao consigo entrar no app". As duas saidas sempre sao as mesmas: o numero
-- da ficha esta errado, ou a pessoa esqueceu a senha. Mandar o aluno voltar na
-- recepcao por isso e perder o aluno no meio do caminho.
--
-- Mas o instrutor NAO deve ficar com a lista de telefones dos alunos. Entao o
-- numero aparece mascarado — 849****0774 — o bastante pra conferir com o aluno
-- ("termina em 0774?") e, se estiver errado, o proprio aluno dita o novo.
--
-- A senha ele redefine as cegas: poe uma nova, nunca descobre a antiga.

-- Quem pode mexer na ficha deste aluno: admin ou professor da MESMA empresa.
create or replace function public.academia_pode_cuidar_do_aluno(p_aluno uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from academia_alunos a
    join profiles eu on eu.id = auth.uid()
    where a.id = p_aluno
      and eu.empresa_id = a.empresa_id
      and eu.perfil in ('admin', 'super_admin', 'professor')
  );
$$;

-- O numero mascarado, mais o que o aluno precisa pra entrar.
create or replace function public.academia_contato_do_aluno(p_aluno uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_fone text;
  v_tem_conta boolean;
begin
  if not academia_pode_cuidar_do_aluno(p_aluno) then
    return jsonb_build_object('ok', false, 'erro', 'Sem permissão.');
  end if;

  select regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g'), a.profile_id is not null
    into v_fone, v_tem_conta
  from academia_alunos a where a.id = p_aluno;

  return jsonb_build_object(
    'ok', true,
    'final', case when length(v_fone) >= 4 then right(v_fone, 4) end,
    -- numero curto demais pra esconder o meio sai so com o fim
    'mascara', case
       when length(v_fone) >= 9 then left(v_fone, 3) || repeat('*', length(v_fone) - 7) || right(v_fone, 4)
       when length(v_fone) >= 4 then repeat('*', length(v_fone) - 4) || right(v_fone, 4)
     end,
    'tem_conta', coalesce(v_tem_conta, false),
    'entra_app', coalesce(v_tem_conta, false) and length(v_fone) >= 4
  );
end $$;

-- Trocar o numero. O gatilho academia_senha_segue_telefone acerta a senha de
-- quem nunca entrou; por isso a funcao devolve senha_acompanhou, pra tela nao
-- prometer ao aluno uma senha que nao mudou.
create or replace function public.academia_trocar_telefone_aluno(p_aluno uuid, p_telefone text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_fone  text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_senha boolean;
begin
  if not academia_pode_cuidar_do_aluno(p_aluno) then
    return jsonb_build_object('ok', false, 'erro', 'Sem permissão.');
  end if;
  if length(v_fone) < 10 then
    return jsonb_build_object('ok', false, 'erro', 'Digite o número com DDD.');
  end if;
  if length(v_fone) > 13 then
    return jsonb_build_object('ok', false, 'erro', 'Esse número tem dígitos demais.');
  end if;

  -- Um telefone, um aluno: e por ele que o aluno entra no app.
  if exists (
    select 1 from academia_alunos o
    where o.id <> p_aluno
      and regexp_replace(coalesce(o.telefone, ''), '\D', '', 'g') = v_fone
  ) then
    return jsonb_build_object('ok', false, 'erro', 'Esse número já está em outro aluno. Chame a recepção.');
  end if;

  select u.last_sign_in_at is null into v_senha
  from academia_alunos a join auth.users u on u.id = a.profile_id
  where a.id = p_aluno;

  update academia_alunos set telefone = v_fone where id = p_aluno;

  return jsonb_build_object('ok', true, 'final', right(v_fone, 4),
                            'senha_acompanhou', coalesce(v_senha, false));
end $$;

-- Senha nova, sem saber a antiga. Sao os 4 numeros do teclado do aluno.
create or replace function public.academia_redefinir_senha_aluno(p_aluno uuid, p_senha text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_perfil uuid;
  v_senha text := regexp_replace(coalesce(p_senha, ''), '\D', '', 'g');
begin
  if not academia_pode_cuidar_do_aluno(p_aluno) then
    return jsonb_build_object('ok', false, 'erro', 'Sem permissão.');
  end if;
  if length(v_senha) <> 4 then
    return jsonb_build_object('ok', false, 'erro', 'A senha do aluno são 4 números.');
  end if;

  select profile_id into v_perfil from academia_alunos where id = p_aluno;
  if v_perfil is null then
    return jsonb_build_object('ok', false, 'erro', 'Este aluno ainda não tem conta no app. Chame a recepção.');
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(v_senha, extensions.gen_salt('bf')),
         updated_at = now()
   where id = v_perfil;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.academia_pode_cuidar_do_aluno(uuid) from public, anon;
revoke all on function public.academia_contato_do_aluno(uuid) from public, anon;
revoke all on function public.academia_trocar_telefone_aluno(uuid, text) from public, anon;
revoke all on function public.academia_redefinir_senha_aluno(uuid, text) from public, anon;
grant execute on function public.academia_pode_cuidar_do_aluno(uuid) to authenticated;
grant execute on function public.academia_contato_do_aluno(uuid) to authenticated;
grant execute on function public.academia_trocar_telefone_aluno(uuid, text) to authenticated;
grant execute on function public.academia_redefinir_senha_aluno(uuid, text) to authenticated;
