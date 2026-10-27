-- GARÇOM NÃO APAGA ITEM DEPOIS DE ENVIADO (27/10/2026)
--
-- Pedido da AGV: depois que o item foi lançado (e saiu pra cozinha), o garçom
-- não pode mais tirar. Outras lojas confiam no garçom e não querem ter que
-- conferir — por isso é uma chave por loja, em Funcionários, e o padrão é o
-- de sempre (pode apagar).
--
-- Desligada a chave, o GARÇOM não consegue:
--   • apagar um item da comanda;
--   • diminuir a quantidade;
--   • cancelar uma comanda que já tem item (seria apagar tudo de uma vez).
-- ADM, caixa e cozinha seguem como antes. Quem errou chama o ADM.
--
-- A trava é no BANCO, igual à da comanda fechada (mig 0321): esconder o botão
-- na tela não basta, celular com versão velha passaria por fora.
--
-- Só vale pro que vem DIRETO do app (current_user = authenticated). Função do
-- banco que roda como dona (separar_comanda, mig 0229, diminui a linha e cria
-- a cópia na outra conta) passa — ali nada some, só muda de conta. Por isso as
-- funções abaixo NÃO são security definer: se fossem, current_user nunca seria
-- o do app.
--
-- Cascata (excluir_empresa_completa) tem guarda: se a comanda já sumiu junto,
-- não é o garçom apagando, e passa.

alter table public.empresas
  add column if not exists garcom_apaga_enviado boolean not null default true;

create or replace function public.trava_garcom_apagar_item()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_comanda uuid := coalesce(new.comanda_id, old.comanda_id);
  v_empresa uuid;
begin
  if current_user <> 'authenticated' then return coalesce(new, old); end if;
  if tg_op = 'UPDATE' and coalesce(new.quantidade, 0) >= coalesce(old.quantidade, 0) then
    return new;
  end if;

  select c.empresa_id into v_empresa from comandas c where c.id = v_comanda;
  if not found then return coalesce(new, old); end if;

  if not exists (select 1 from profiles p where p.id = auth.uid() and p.perfil = 'garcom') then
    return coalesce(new, old);
  end if;
  if coalesce((select e.garcom_apaga_enviado from empresas e where e.id = v_empresa), true) then
    return coalesce(new, old);
  end if;

  raise exception
    'Item já enviado não pode ser apagado pelo garçom. Chame o administrador.'
    using errcode = 'P0001';
end $$;

drop trigger if exists trg_trava_garcom_apagar_item on public.comanda_itens;
create trigger trg_trava_garcom_apagar_item
  before update or delete on public.comanda_itens
  for each row execute function public.trava_garcom_apagar_item();

create or replace function public.trava_garcom_cancelar_comanda()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if new.status is distinct from 'cancelada' or old.status = 'cancelada' then return new; end if;
  if not exists (select 1 from comanda_itens i where i.comanda_id = new.id) then return new; end if;
  if not exists (select 1 from profiles p where p.id = auth.uid() and p.perfil = 'garcom') then return new; end if;
  if coalesce((select e.garcom_apaga_enviado from empresas e where e.id = new.empresa_id), true) then return new; end if;

  raise exception
    'Comanda com item lançado não pode ser cancelada pelo garçom. Chame o administrador.'
    using errcode = 'P0001';
end $$;

drop trigger if exists trg_trava_garcom_cancelar_comanda on public.comandas;
create trigger trg_trava_garcom_cancelar_comanda
  before update on public.comandas
  for each row execute function public.trava_garcom_cancelar_comanda();
