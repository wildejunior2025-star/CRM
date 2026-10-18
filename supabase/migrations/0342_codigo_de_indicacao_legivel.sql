-- Link de indicação legível: ?ref=jose-martins em vez de ?ref=f1dbbac7.
--
-- NÃO usa o e-mail/login do cliente: o link vai por WhatsApp, e e-mail dentro dele
-- entrega dado pessoal, é adivinhável e quebra quando o cliente troca de e-mail.
-- Usa as duas primeiras palavras do NOME; se já existir, ganha número (jose-martins2).
--
-- Tudo no sistema compara ref_token por igualdade (get_referrer_name, fn_set_ref_token,
-- completar_cadastro_google, get_root_ref_token), então o formato é livre.
-- Os códigos antigos estão guardados em backup_rede_indicacao_0340_profiles.

create extension if not exists unaccent;

create or replace function public.ref_codigo_legivel(p_nome text, p_ignorar uuid default null)
returns text
language plpgsql
set search_path = public
as $$
declare
  v_base text;
  v_tent text;
  v_n    int := 1;
begin
  -- Nome que é e-mail ou telefone (cadastro pelo WhatsApp) não vira código: cai no aleatório.
  if p_nome is null or p_nome like '%@%' or p_nome ~ '^[0-9 ()+.-]+$' then
    return null;
  end if;

  select string_agg(w, '-' order by i)
    into v_base
    from (
      select w, i
        from unnest(string_to_array(
               regexp_replace(lower(unaccent(p_nome)), '[^a-z0-9]+', ' ', 'g'), ' '))
             with ordinality as t(w, i)
       where w <> ''
       order by i
       limit 2
    ) x;

  if v_base is null or length(v_base) < 3 then
    return null;
  end if;

  v_base := left(v_base, 30);
  v_tent := v_base;
  while exists (select 1 from profiles where ref_token = v_tent and id is distinct from p_ignorar) loop
    v_n := v_n + 1;
    v_tent := v_base || v_n;
  end loop;
  return v_tent;
end;
$$;

-- Gatilho: cliente e raiz ganham o código legível; sem nome aproveitável, o aleatório de antes.
create or replace function public.fn_set_ref_token()
returns trigger
language plpgsql
security definer
as $function$
declare
  v_tok      text;
  v_referrer uuid;
begin
  -- Só cliente e super_admin participam da rede (mig 0340).
  if NEW.perfil not in ('cliente', 'super_admin') then
    return NEW;
  end if;

  if NEW.ref_token is null then
    v_tok := public.ref_codigo_legivel(NEW.nome, NEW.id);
    if v_tok is null then
      loop
        v_tok := lower(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));
        exit when not exists (select 1 from profiles where ref_token = v_tok);
      end loop;
    end if;
    NEW.ref_token := v_tok;
  end if;

  select p.id into v_referrer
  from profiles p
  where p.ref_token = (select raw_user_meta_data->>'ref_by_token' from auth.users where id = NEW.id)
    and p.id != NEW.id
  limit 1;

  if v_referrer is null then
    select p.id into v_referrer
    from profiles p
    join configuracoes_plataforma cfg on cfg.chave = 'link_raiz_token' and cfg.valor = p.ref_token
    where p.id != NEW.id
    limit 1;
  end if;

  if v_referrer is not null then
    NEW.indicado_por := v_referrer;
  end if;

  return NEW;
end;
$function$;

-- Quem já existe troca agora (só 4 contas, links de teste). A raiz leva junto o
-- `link_raiz_token`, que aponta pro código dela.
do $$
declare
  r record;
  v_novo text;
  v_raiz uuid;
begin
  select id into v_raiz from profiles where perfil = 'super_admin' order by created_at limit 1;

  for r in
    select id, nome from profiles
     where perfil in ('cliente', 'super_admin') and ref_token is not null
     order by created_at
  loop
    v_novo := public.ref_codigo_legivel(r.nome, r.id);
    if v_novo is not null then
      update profiles set ref_token = v_novo where id = r.id;
      if r.id = v_raiz then
        update configuracoes_plataforma set valor = v_novo where chave = 'link_raiz_token';
      end if;
    end if;
  end loop;
end $$;
