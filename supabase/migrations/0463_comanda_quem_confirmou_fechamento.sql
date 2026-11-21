-- 0463 — Comanda: guarda QUEM confirmou o fechamento da conta (ZN Bar, 21/11/2026)
--
-- O garçom fecha a conta no celular (comandas.fechada_por / fechada_por_em) e a mesa fica azul, aguardando o
-- administrador. Quando o admin confirma, a venda nasce — mas o sistema nao guardava QUEM confirmou. Na madrugada
-- de 21/11 a mesa 16 do ZN Bar "sumiu" e nao deu pra dizer quem a liberou (a loja tem 2 admins).
--
-- Um gatilho em comandas pega qualquer caminho que feche a conta (fechar_conta_presencial, liberar mesa, edicao
-- no gestor): quando o status vira 'fechada', grava o usuario logado e a hora. Nao mexe em fechada_por, que segue
-- sendo o garçom (ranking do salao, mig 0187).

alter table comandas
  add column if not exists confirmada_por uuid,
  add column if not exists confirmada_em  timestamptz;

create or replace function comanda_guardar_quem_confirmou() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'fechada' and old.status is distinct from 'fechada' then
    new.confirmada_por := coalesce(auth.uid(), new.confirmada_por);
    new.confirmada_em  := coalesce(new.confirmada_em, now());
  end if;
  return new;
end $$;

drop trigger if exists trg_comanda_quem_confirmou on comandas;
create trigger trg_comanda_quem_confirmou
  before update of status on comandas
  for each row execute function comanda_guardar_quem_confirmou();
