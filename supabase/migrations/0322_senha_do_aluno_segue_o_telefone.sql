-- A senha do aluno segue o telefone da ficha.
--
-- A regra que a recepcao fala pra todo mundo e "sua senha sao os 4 ultimos do
-- seu celular". So que a conta nasce com a senha de quem ela era NA HORA: sem
-- telefone na ficha, a senha vira a matricula. Quando a recepcao botava o
-- numero depois, a senha ficava pra tras — e o aluno digitava os 4 do celular,
-- levava "senha errada" e desistia. Ninguem reclama, entao ninguem descobre:
-- 27 alunos estavam assim, nenhum tinha entrado no app uma vez sequer.
--
-- Agora, ao gravar o telefone de um aluno que NUNCA entrou, a senha acompanha.
-- Quem ja entrou nao e tocado: a senha pode ser dele, escolhida.

-- Primeiro, acerta quem ja estava torto (so quem nunca entrou).
with alvo as (
  select u.id, right(regexp_replace(a.telefone, '\D', '', 'g'), 4) as nova
  from academia_alunos a
  join auth.users u on u.id = a.profile_id
  where length(regexp_replace(coalesce(a.telefone, ''), '\D', '', 'g')) >= 4
    and u.last_sign_in_at is null
    and u.encrypted_password <> extensions.crypt(
          right(regexp_replace(a.telefone, '\D', '', 'g'), 4), u.encrypted_password)
)
update auth.users u
set encrypted_password = extensions.crypt(alvo.nova, extensions.gen_salt('bf')),
    updated_at = now()
from alvo where u.id = alvo.id;

create or replace function public.academia_senha_segue_telefone()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_fone text := regexp_replace(coalesce(new.telefone, ''), '\D', '', 'g');
begin
  if new.profile_id is null or length(v_fone) < 4 then
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

drop trigger if exists academia_senha_segue_telefone on academia_alunos;
create trigger academia_senha_segue_telefone
  after insert or update of telefone, profile_id on academia_alunos
  for each row
  execute function public.academia_senha_segue_telefone();

comment on function public.academia_senha_segue_telefone is
  'Quando a ficha do aluno ganha ou troca o telefone, a senha do app passa a ser os 4 ultimos dele — mas so para quem nunca entrou, para nao derrubar senha escolhida.';
