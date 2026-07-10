-- Despesas fixas do sistema (custos que o dono paga para manter a plataforma no ar).
-- Gerenciado no Super ADM. Cada despesa pode ter recorrência, vencimento e alerta.

create table if not exists public.despesas_sistema (
  id                uuid primary key default gen_random_uuid(),
  nome              text not null,
  categoria         text not null default 'infra',   -- infra | dominio | pagamentos | app | ia | contador | outro
  valor             numeric(12,2) default 0,
  moeda             text not null default 'BRL',      -- BRL | USD
  recorrencia       text not null default 'mensal',   -- mensal | anual | unico | por_uso
  dia_vencimento    int,                              -- dia do mês (1-31) para recorrência mensal (opcional)
  data_vencimento   date,                             -- próximo vencimento (usado nos alertas)
  pago_em           date,                             -- último pagamento registrado
  alerta_ativo      boolean not null default false,
  alerta_dias_antes int not null default 3,
  ativo             boolean not null default true,
  url               text,                             -- link do painel do serviço
  observacoes       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.despesas_sistema is 'Despesas fixas do dono da plataforma (infra, domínio, etc). Gerenciado no Super ADM.';

alter table public.despesas_sistema enable row level security;

drop policy if exists super_admin_gerencia_despesas on public.despesas_sistema;
create policy super_admin_gerencia_despesas on public.despesas_sistema
  for all
  using (current_perfil() = 'super_admin')
  with check (current_perfil() = 'super_admin');

-- Semear com os serviços já conhecidos (valores/datas em branco para o dono preencher).
insert into public.despesas_sistema (nome, categoria, recorrencia, moeda, observacoes) values
  ('Supabase — CRM',                 'infra',      'mensal', 'BRL', 'Banco de dados do CRM'),
  ('Supabase — site construção',     'infra',      'mensal', 'BRL', 'Projeto site construção civil'),
  ('Supabase — aplicativo web',      'infra',      'mensal', 'BRL', 'Projeto app web'),
  ('Cloudflare',                     'infra',      'mensal', 'BRL', 'Hospedagem Workers/Pages (CRM + landing)'),
  ('Domínio fwcinter.com',           'dominio',    'anual',  'BRL', 'Renovação anual do domínio'),
  ('Mercado Pago',                   'pagamentos', 'por_uso','BRL', 'Sem mensalidade — taxa por transação'),
  ('Efí (PIX)',                      'pagamentos', 'por_uso','BRL', 'Sem mensalidade — taxa por transação'),
  ('Play Store',                     'app',        'unico',  'USD', 'Taxa única de US$ 25 (já paga)'),
  ('Meta WhatsApp Cloud API',        'app',        'por_uso','BRL', 'Cano oficial do bot — cobra por conversa (futuro)'),
  ('Anthropic (Claude / IA)',        'ia',         'por_uso','BRL', 'Leitor de print e IA do bot — cobra por uso');
