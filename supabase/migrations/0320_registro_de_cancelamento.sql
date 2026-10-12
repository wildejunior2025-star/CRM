-- QUEM CANCELOU, QUANDO E O QUE (11/10/2026)
--
-- A dona da Saidera perguntou se garçom estava cancelando mesa em vez de
-- confirmar, depois de receber. A resposta foi que NÃO DAVA PRA SABER:
-- cancelar gravava só `status = 'cancelada'` — sem autor, sem hora, sem
-- motivo — e remover item era um DELETE seco, que não deixava nada.
--
-- Em 45 dias a Saidera tinha 207 comandas canceladas JÁ COM ITENS, somando
-- R$ 8.460,77. Olhando semana a semana deu pra ver que o grosso era da
-- montagem da loja (19% em agosto, 5,2% na última semana), mas isso foi
-- dedução pela data — não por registro.
--
-- Agora fica gravado. Não é acusação: cliente desiste de uma cerveja todo dia.
-- É registro, e registro que aparece PRA QUEM FEZ e pro dono é o que faz a
-- conversa ser sobre fato.
--
-- POR QUE GATILHO E NÃO CÓDIGO DE TELA: a remoção de item acontece em vários
-- caminhos (salão, painel, app do garçom) e a comanda é cancelada em dois
-- lugares diferentes só no salão. No gatilho, nenhum caminho escapa — e
-- ninguém consegue apagar o próprio rastro, porque a tabela não tem policy de
-- escrita: só os gatilhos (security definer) gravam.

create table if not exists public.comanda_eventos (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  comanda_id  uuid,
  rotulo      text,
  tipo        text not null check (tipo in ('item_removido','comanda_cancelada')),
  quem        uuid references public.profiles(id) on delete set null,
  quando      timestamptz not null default now(),
  descricao   text,
  quantidade  numeric,
  valor       numeric not null default 0
);

create index if not exists idx_comanda_eventos_empresa on public.comanda_eventos (empresa_id, quando desc);
create index if not exists idx_comanda_eventos_quem    on public.comanda_eventos (empresa_id, quem, quando desc);

alter table public.comanda_eventos enable row level security;

-- Garçom vê só o dele; dono vê a loja. Mesma regra do extrato (extrato_garcom).
drop policy if exists comanda_eventos_le on public.comanda_eventos;
create policy comanda_eventos_le on public.comanda_eventos
  for select to authenticated
  using (
    empresa_id = (select empresa_id from profiles where id = auth.uid())
    and (current_perfil() in ('admin', 'super_admin') or quem = auth.uid())
  );

create or replace function public.log_item_removido()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_rot text;
begin
  -- Cascata (comanda ou loja apagada) NÃO é remoção de item: a comanda já
  -- sumiu junto. Sem esta guarda, apagar uma loja geraria um evento por item.
  select rotulo_comanda(c) into v_rot from comandas c where c.id = old.comanda_id;
  if not found then return null; end if;

  insert into comanda_eventos (empresa_id, comanda_id, rotulo, tipo, quem, descricao, quantidade, valor)
  values (old.empresa_id, old.comanda_id, v_rot, 'item_removido', auth.uid(),
          old.nome, old.quantidade,
          round(coalesce(old.preco_unitario, 0) * coalesce(old.quantidade, 0), 2));
  return null;
end $$;

drop trigger if exists trg_log_item_removido on public.comanda_itens;
create trigger trg_log_item_removido
  after delete on public.comanda_itens
  for each row execute function public.log_item_removido();

create or replace function public.log_comanda_cancelada()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_itens int; v_valor numeric;
begin
  if new.status <> 'cancelada' or coalesce(old.status, '') = 'cancelada' then return null; end if;

  select count(*), round(coalesce(sum(preco_unitario * quantidade), 0), 2)
    into v_itens, v_valor
    from comanda_itens where comanda_id = new.id;

  insert into comanda_eventos (empresa_id, comanda_id, rotulo, tipo, quem, descricao, quantidade, valor)
  values (new.empresa_id, new.id, rotulo_comanda(new), 'comanda_cancelada', auth.uid(),
          case when v_itens = 0 then 'Comanda vazia' else v_itens || ' item(ns) lançado(s)' end,
          v_itens, v_valor);
  return null;
end $$;

drop trigger if exists trg_log_comanda_cancelada on public.comandas;
create trigger trg_log_comanda_cancelada
  after update of status on public.comandas
  for each row execute function public.log_comanda_cancelada();
