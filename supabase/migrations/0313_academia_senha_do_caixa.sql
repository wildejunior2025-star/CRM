-- Senha do caixa: trava receber mensalidade, mexer no vencimento e ver os
-- pagamentos do dia.
--
-- A academia inteira entra com UM login só (dono, recepção, quem estiver no
-- balcão). Sem isso, qualquer um que pegue o computador recebe dinheiro e vê
-- o faturamento do mês. É uma senha diferente da do login, de propósito.
--
-- A senha nunca trafega nem fica guardada em texto: vai cifrada com bcrypt,
-- e o site só pergunta "essa senha confere?".
create extension if not exists pgcrypto;

create table if not exists academia_config (
  empresa_id uuid primary key references empresas(id) on delete cascade,
  senha_hash text,
  atualizado_em timestamptz not null default now()
);

-- Ninguém lê essa tabela pelo site: o hash só é tocado pelas funções abaixo.
alter table academia_config enable row level security;

create or replace function academia_minha_empresa()
returns uuid language sql stable security definer set search_path = public as
$$ select empresa_id from profiles where id = auth.uid() $$;

create or replace function academia_tem_senha()
returns boolean language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from academia_config
     where empresa_id = academia_minha_empresa() and senha_hash is not null
   ) $$;

-- Define ou troca a senha. Pra trocar, tem que saber a atual.
-- ATENÇÃO: o pgcrypto do Supabase mora no schema `extensions`, e estas
-- funções travam o search_path em `public` por segurança — por isso crypt e
-- gen_salt vêm com o schema na frente.
create or replace function academia_definir_senha(p_nova text, p_atual text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_empresa uuid := academia_minha_empresa(); v_hash text;
begin
  if v_empresa is null then return false; end if;
  if length(coalesce(p_nova, '')) < 4 then
    raise exception 'A senha precisa de pelo menos 4 caracteres.';
  end if;
  select senha_hash into v_hash from academia_config where empresa_id = v_empresa;
  if v_hash is not null and (p_atual is null or extensions.crypt(p_atual, v_hash) <> v_hash) then
    return false;
  end if;
  insert into academia_config (empresa_id, senha_hash)
  values (v_empresa, extensions.crypt(p_nova, extensions.gen_salt('bf')))
  on conflict (empresa_id)
    do update set senha_hash = excluded.senha_hash, atualizado_em = now();
  return true;
end $$;

create or replace function academia_conferir_senha(p_senha text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_hash text;
begin
  select senha_hash into v_hash from academia_config
  where empresa_id = academia_minha_empresa();
  if v_hash is null then return true; end if;   -- sem senha cadastrada, passa
  return extensions.crypt(coalesce(p_senha, ''), v_hash) = v_hash;
end $$;

grant execute on function academia_minha_empresa() to authenticated;
grant execute on function academia_tem_senha() to authenticated;
grant execute on function academia_definir_senha(text, text) to authenticated;
grant execute on function academia_conferir_senha(text) to authenticated;
