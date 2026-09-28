-- Aviso de mensagem nova no WhatsApp da FWC (Evolution, instância do admin).
--
-- O número oficial (99912-0349) fica num celular que ninguém olha o dia todo.
-- Cada contato que escreve vira um aviso no WhatsApp pessoal do dono
-- (config_global.aviso_fwc_destino). Esta tabela só guarda quando o último
-- aviso de cada contato saiu: quem manda 5 mensagens seguidas gera 1 aviso.

create table if not exists public.aviso_fwc_entrada (
  telefone    text primary key,
  avisado_em  timestamptz not null default now()
);

alter table public.aviso_fwc_entrada enable row level security;
-- Sem policy: só a edge function (service role) lê e escreve.

insert into public.config_global (chave, valor, atualizado_em)
values ('aviso_fwc_destino', '5584998180774', now())
on conflict (chave) do update set valor = excluded.valor, atualizado_em = now();
