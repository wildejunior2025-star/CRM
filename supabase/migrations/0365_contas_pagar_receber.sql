-- 0365 — CONTAS A PAGAR E A RECEBER
--
-- Módulo novo do Financeiro: o que a loja DEVE (fornecedor, luz, aluguel…) e o que tem a RECEBER
-- (venda a prazo, repasse, empréstimo…), com vencimento, baixa (inclusive parcial), parcelamento e
-- repetição. O fiado de clientes continua no módulo dele (clientes_saldo_fiado); a tela só o mostra.
--
-- Não mexe no lucro: o lucro segue pelo fechamento do dia (historico_dia). Conta é CAIXA/compromisso —
-- somar o aluguel aqui e de novo em "Despesas & Lucro" contaria duas vezes.
--
-- contas_financeiras  : a conta em si (tipo pagar|receber, valor, vencimento, status).
-- contas_baixas       : cada pagamento/recebimento (permite parcial). Um trigger mantém valor_pago e status.
-- Repetição (semanal/quinzenal/mensal/anual): quando a conta é quitada, nasce a próxima (trigger),
--   preservando o DIA do mês (aluguel dia 31 não vira dia 28 pra sempre).
-- Vencida NÃO é status gravado: é "aberta com vencimento < hoje" (a tela calcula).

create table if not exists contas_financeiras (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null default current_empresa_id() references empresas(id) on delete cascade,
  tipo          text not null check (tipo in ('pagar', 'receber')),
  descricao     text not null check (length(btrim(descricao)) > 0),
  pessoa        text,                                   -- fornecedor (pagar) ou quem vai pagar (receber)
  cliente_id    uuid references clientes(id) on delete set null,
  categoria     text,
  valor         numeric(12,2) not null check (valor > 0),
  vencimento    date not null,
  status        text not null default 'aberta' check (status in ('aberta', 'paga', 'cancelada')),
  valor_pago    numeric(12,2) not null default 0,       -- soma das baixas (mantido por trigger)
  pago_em       date,                                   -- data da última baixa, quando quitada
  forma_pagamento text,
  observacao    text,
  recorrencia   text not null default 'nenhuma' check (recorrencia in ('nenhuma', 'semanal', 'quinzenal', 'mensal', 'anual')),
  dia_ref       integer,                                -- dia do mês original (recorrência mensal/anual)
  grupo_id      uuid,                                   -- agrupa parcelas e repetições da mesma conta
  parcela       integer,
  parcelas      integer,
  origem        text not null default 'portal' check (origem in ('portal', 'whatsapp')),
  criado_por    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists contas_baixas (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null default current_empresa_id() references empresas(id) on delete cascade,
  conta_id    uuid not null references contas_financeiras(id) on delete cascade,
  valor       numeric(12,2) not null check (valor > 0),
  data        date not null default ((now() at time zone 'America/Sao_Paulo')::date),
  forma       text,
  observacao  text,
  origem      text not null default 'portal' check (origem in ('portal', 'whatsapp')),
  criado_por  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists idx_contas_empresa_venc on contas_financeiras (empresa_id, tipo, status, vencimento);
create index if not exists idx_contas_grupo on contas_financeiras (grupo_id) where grupo_id is not null;
create index if not exists idx_contas_baixas_conta on contas_baixas (conta_id);

-- Antes de gravar: guarda o dia de referência e dá um grupo pra conta que se repete.
create or replace function contas_antes_inserir() returns trigger language plpgsql as $$
begin
  new.dia_ref := coalesce(new.dia_ref, extract(day from new.vencimento)::int);
  if new.recorrencia <> 'nenhuma' and new.grupo_id is null then new.grupo_id := new.id; end if;
  return new;
end $$;
drop trigger if exists trg_contas_antes_inserir on contas_financeiras;
create trigger trg_contas_antes_inserir before insert on contas_financeiras
  for each row execute function contas_antes_inserir();

-- Cada baixa recalcula quanto já foi pago e se a conta está quitada.
create or replace function contas_baixas_atualiza() returns trigger language plpgsql security definer set search_path = public as $$
declare v_conta uuid := coalesce(new.conta_id, old.conta_id);
        v_pago numeric; v_ult date; v_forma text;
begin
  select coalesce(sum(valor), 0), max(data) into v_pago, v_ult from contas_baixas where conta_id = v_conta;
  select forma into v_forma from contas_baixas where conta_id = v_conta order by data desc, created_at desc limit 1;
  update contas_financeiras set
    valor_pago = v_pago,
    status = case when status = 'cancelada' then status when v_pago >= valor then 'paga' else 'aberta' end,
    pago_em = case when v_pago >= valor then v_ult else null end,
    forma_pagamento = coalesce(v_forma, forma_pagamento),
    updated_at = now()
  where id = v_conta;
  return null;
end $$;
drop trigger if exists trg_contas_baixas on contas_baixas;
create trigger trg_contas_baixas after insert or update or delete on contas_baixas
  for each row execute function contas_baixas_atualiza();

-- Conta que se repete: ao quitar, nasce a próxima (uma só; não duplica se já existir).
create or replace function contas_gera_proxima() returns trigger language plpgsql security definer set search_path = public as $$
declare v_prox date; v_base date; v_dia int; v_ultimo int;
begin
  if new.status = 'paga' and old.status is distinct from 'paga' and new.recorrencia <> 'nenhuma' then
    v_base := new.vencimento;
    v_dia := coalesce(new.dia_ref, extract(day from v_base)::int);
    if new.recorrencia = 'semanal' then v_prox := v_base + 7;
    elsif new.recorrencia = 'quinzenal' then v_prox := v_base + 15;
    else
      v_base := (date_trunc('month', v_base) + case when new.recorrencia = 'anual' then interval '12 months' else interval '1 month' end)::date;
      v_ultimo := extract(day from (date_trunc('month', v_base) + interval '1 month - 1 day'))::int;
      v_prox := v_base + (least(v_dia, v_ultimo) - 1);
    end if;
    if exists (select 1 from contas_financeiras where grupo_id = new.grupo_id and vencimento >= v_prox and status <> 'cancelada') then
      return new;
    end if;
    insert into contas_financeiras (empresa_id, tipo, descricao, pessoa, cliente_id, categoria, valor, vencimento, observacao,
                                    recorrencia, dia_ref, grupo_id, origem, criado_por)
    values (new.empresa_id, new.tipo, new.descricao, new.pessoa, new.cliente_id, new.categoria, new.valor, v_prox, new.observacao,
            new.recorrencia, v_dia, new.grupo_id, new.origem, new.criado_por);
  end if;
  return new;
end $$;
drop trigger if exists trg_contas_gera_proxima on contas_financeiras;
create trigger trg_contas_gera_proxima after update of status on contas_financeiras
  for each row execute function contas_gera_proxima();

-- Segurança: só o administrador da própria loja (o robô do WhatsApp usa service_role e ignora a RLS).
alter table contas_financeiras enable row level security;
alter table contas_baixas enable row level security;

drop policy if exists contas_financeiras_admin on contas_financeiras;
create policy contas_financeiras_admin on contas_financeiras for all to authenticated
  using (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin')
  with check (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin');

drop policy if exists contas_baixas_admin on contas_baixas;
create policy contas_baixas_admin on contas_baixas for all to authenticated
  using (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin')
  with check (empresa_id = (select current_empresa_id()) and (select current_perfil()) = 'admin');

-- O robô cria/baixa conta pelo WhatsApp: o desfazer precisa apagar o que criou.
alter table assistente_acoes drop constraint if exists assistente_acoes_tipo_check;
alter table assistente_acoes add constraint assistente_acoes_tipo_check
  check (tipo in ('cadastrar_produto','mudar_preco','taxa_entrega_fixa','pedido_minimo','ajustar_tabela_km','definir_minimo',
                  'conta_criar','conta_baixar'));
