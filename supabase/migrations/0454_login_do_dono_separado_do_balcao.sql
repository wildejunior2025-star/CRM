-- Login do dono separado do login do balcao.
--
-- Ate aqui a academia inteira entrava com UM login de "admin" — dono, recepcao,
-- quem estivesse no balcao — e esse login via o caixa do dia e o total do mes.
-- O dono pediu o contrario: ele quer ver tudo, e quem recebe e da baixa nao
-- pode ver quanto esta entrando na conta.
--
-- Nao virou perfil novo de proposito. 'admin' e 'professor' ja existem e toda a
-- RLS da academia e por empresa, nao por perfil; criar um terceiro perfil
-- mexeria em todas elas. O que muda e uma chave por LOGIN: ver_financeiro.

alter table profiles
  add column if not exists ver_financeiro boolean not null default true;

comment on column profiles.ver_financeiro is
  'Este login enxerga dinheiro (caixa, total do mes, Equipe)? Recepcao da academia fica false: recebe e da baixa, mas nao ve quanto entrou.';

create or replace function public.academia_ve_financeiro()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((select p.ver_financeiro from profiles p where p.id = auth.uid()), false);
$$;

revoke all on function public.academia_ve_financeiro() from public, anon;
grant execute on function public.academia_ve_financeiro() to authenticated;

-- Esconder a tela nao basta: sem isto o balcao continuaria conseguindo ler os
-- pagamentos pelo endereco do banco.
drop policy if exists "academia_pagamentos loja le" on academia_pagamentos;
create policy "academia_pagamentos loja le" on academia_pagamentos
  for select
  using (
    empresa_id = (select current_empresa_id())
    and (select academia_ve_financeiro())
  );

-- Mas a trava de clique duplo PRECISA saber se ja recebemos desta pessoa hoje,
-- e ela roda justamente no login do balcao, que perdeu a leitura da tabela.
-- Entao a pergunta vira uma funcao: devolve SO o que a tela precisa dizer
-- ("ja foi recebido R$ 60 as 19:35"), de um aluno so, do dia informado.
create or replace function public.academia_ja_recebi_hoje(p_aluno uuid, p_data date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare r record;
begin
  if not academia_pode_cuidar_do_aluno(p_aluno) then
    return null;
  end if;

  select p.valor, p.criado_em into r
  from academia_pagamentos p
  where p.aluno_id = p_aluno
    and p.data = p_data
    and p.cancelado = false
  order by p.criado_em desc
  limit 1;

  if not found then return null; end if;
  return jsonb_build_object('valor', r.valor, 'criado_em', r.criado_em);
end $$;

revoke all on function public.academia_ja_recebi_hoje(uuid, date) from public, anon;
grant execute on function public.academia_ja_recebi_hoje(uuid, date) to authenticated;

-- A tela de Equipe passa a ligar/desligar essa chave. Quem nao ve o financeiro
-- tambem nao mexe na equipe — senao a recepcao criaria um login de dono pra si
-- mesma e a separacao nao valeria nada.
create or replace function public.academia_editar_equipe(
  p_id uuid,
  p_nome text default null,
  p_email text default null,
  p_telefone text default null,
  p_perfil text default null,
  p_senha text default null,
  p_ver_financeiro boolean default null
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

  -- Quem chamou precisa ser admin da mesma empresa E enxergar o financeiro.
  if not exists (
    select 1 from profiles eu
    where eu.id = auth.uid()
      and eu.empresa_id = alvo.empresa_id
      and eu.perfil in ('admin', 'super_admin')
      and eu.ver_financeiro
  ) then
    return jsonb_build_object('ok', false, 'erro', 'Só o dono da academia pode mexer na equipe.');
  end if;

  if alvo.perfil = 'super_admin' then
    return jsonb_build_object('ok', false, 'erro', 'Esta conta não pode ser editada por aqui.');
  end if;

  if p_perfil is not null and p_perfil not in ('admin', 'professor') then
    return jsonb_build_object('ok', false, 'erro', 'Acesso inválido.');
  end if;

  -- O dono nao pode tirar o proprio acesso ao dinheiro e ficar trancado do
  -- lado de fora: so sobraria a FWC pra devolver.
  if p_ver_financeiro is false and p_id = auth.uid() then
    return jsonb_build_object('ok', false, 'erro', 'Você não pode tirar o seu próprio acesso ao financeiro. Peça para outro dono fazer isso.');
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
         email    = coalesce(v_mail, email),
         ver_financeiro = coalesce(p_ver_financeiro, ver_financeiro)
   where id = p_id;

  return jsonb_build_object('ok', true);
end $$;

-- Login recem-criado: a create-vendor nao conhece a chave, entao a tela liga
-- ou desliga logo depois, pelo e-mail que ela acabou de cadastrar.
create or replace function public.academia_equipe_financeiro(p_email text, p_ver boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_mail  text := lower(nullif(trim(p_email), ''));
  v_minha uuid;
  v_id    uuid;
begin
  select empresa_id into v_minha from profiles
  where id = auth.uid() and perfil in ('admin', 'super_admin') and ver_financeiro;
  if v_minha is null then
    return jsonb_build_object('ok', false, 'erro', 'Só o dono da academia pode mexer na equipe.');
  end if;

  select id into v_id from profiles
  where lower(email) = v_mail and empresa_id = v_minha and perfil <> 'super_admin';
  if v_id is null then
    return jsonb_build_object('ok', false, 'erro', 'Não achei esse login na sua academia.');
  end if;
  if v_id = auth.uid() and p_ver is false then
    return jsonb_build_object('ok', false, 'erro', 'Você não pode tirar o seu próprio acesso ao financeiro.');
  end if;

  update profiles set ver_financeiro = p_ver where id = v_id;
  return jsonb_build_object('ok', true);
end $$;
