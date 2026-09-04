-- Robô avisando duas vezes que a loja está fechada
--
-- O cliente mandou "Bom dia" e logo "Ok". Dois webhooks entraram ao mesmo
-- tempo, os dois LERAM o histórico antes de qualquer um GRAVAR a resposta, e
-- os dois concluíram "ainda não avisei". Resultado: o mesmo "a gente tá
-- fechado" duas vezes, com 0,4s de diferença.
--
-- Checar histórico nunca resolve corrida. Quem decide é o banco: um índice
-- único e um INSERT ... ON CONFLICT. Só um dos dois consegue reservar o aviso;
-- o outro descobre na hora que já tem dono e cala.

create table if not exists whatsapp_avisos (
  empresa_id uuid not null references empresas(id) on delete cascade,
  chave      text not null,        -- últimos 8 dígitos do telefone (a Meta às
                                   -- vezes entrega sem o 9 do Nordeste)
  marca      text not null,        -- qual aviso: 'fechada', etc.
  avisado_em timestamptz not null default now(),
  primary key (empresa_id, chave, marca)
);

alter table whatsapp_avisos enable row level security;
-- Sem policy: só as edge functions (service role) escrevem aqui.

comment on table whatsapp_avisos is
  'Trava de aviso do robô: garante que a mesma mensagem automática sai uma vez só, mesmo com dois webhooks simultâneos.';

/**
 * Reserva o aviso. Devolve true pra QUEM conseguiu reservar (ninguém tinha
 * avisado, ou o último aviso já passou da validade) e null pra quem chegou
 * depois. Chamar isto é o que autoriza mandar a mensagem.
 */
create or replace function robo_avisar_uma_vez(
  p_empresa_id uuid,
  p_chave text,
  p_marca text,
  p_minutos int default 60
) returns boolean
language sql
security definer
set search_path = public
as $$
  insert into whatsapp_avisos (empresa_id, chave, marca)
  values (p_empresa_id, p_chave, p_marca)
  on conflict (empresa_id, chave, marca) do update
    set avisado_em = now()
    where whatsapp_avisos.avisado_em < now() - make_interval(mins => p_minutos)
  returning true;
$$;

grant execute on function robo_avisar_uma_vez(uuid, text, text, int) to service_role;
