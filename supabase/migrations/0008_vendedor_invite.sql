-- Migration 0008: adiciona fluxo de convite de vendedor
-- tipo_cadastro='vendedor' + empresa_id no metadata → perfil='vendedor' vinculado à empresa

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo text;
  v_empresa_id uuid;
begin
  v_tipo := new.raw_user_meta_data->>'tipo_cadastro';

  if v_tipo = 'empresa' then
    insert into empresas (nome, status, plano, trial_fim)
    values (
      coalesce(new.raw_user_meta_data->>'nome_empresa', 'Minha empresa'),
      'trial',
      'padrao',
      (now() + interval '14 days')::date
    )
    returning id into v_empresa_id;

    insert into profiles (id, nome, email, perfil, empresa_id)
    values (new.id, coalesce(new.raw_user_meta_data->>'nome', new.email), new.email, 'admin', v_empresa_id)
    on conflict (id) do nothing;

  elsif v_tipo = 'admin_empresa' and (new.raw_user_meta_data->>'empresa_id') is not null then
    insert into profiles (id, nome, email, perfil, empresa_id)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'nome', new.email),
      new.email,
      'admin',
      (new.raw_user_meta_data->>'empresa_id')::uuid
    )
    on conflict (id) do nothing;

  elsif v_tipo = 'vendedor' and (new.raw_user_meta_data->>'empresa_id') is not null then
    insert into profiles (id, nome, email, perfil, empresa_id)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'nome', new.email),
      new.email,
      'vendedor',
      (new.raw_user_meta_data->>'empresa_id')::uuid
    )
    on conflict (id) do nothing;

  elsif v_tipo = 'cliente' and (new.raw_user_meta_data->>'empresa_id') is not null then
    insert into profiles (id, nome, email, perfil, empresa_id)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'nome', new.email),
      new.email,
      'cliente',
      (new.raw_user_meta_data->>'empresa_id')::uuid
    )
    on conflict (id) do nothing;

  else
    insert into profiles (id, nome, email, perfil)
    values (new.id, coalesce(new.raw_user_meta_data->>'nome', new.email), new.email, 'cliente')
    on conflict (id) do nothing;
  end if;

  return new;
end;
$$;
