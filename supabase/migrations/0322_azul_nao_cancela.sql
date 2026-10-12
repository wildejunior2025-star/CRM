-- CONTA AZUL SÓ CONFIRMA, NÃO CANCELA (11/10/2026)
--
-- Azul (`aguardando_conferencia`) quer dizer que o garçom JÁ FECHOU, JÁ
-- IMPRIMIU e JÁ RECEBEU o dinheiro. Aquela tela existe só pra o dono bater o
-- caixa. Mas tinha um botão "Cancelar" ali, e era por onde o dinheiro sumia:
--
--   1. garçom fecha → azul, recebe, imprime
--   2. a venda NÃO é criada (ela nasce quando o ADM libera)
--   3. horas depois alguém vê a mesa azul encalhada e CANCELA
--
-- Resultado: dinheiro no bolso, venda nenhuma no sistema, e a mesa "sumiu"
-- sem ninguém entender. Em 60 dias foram 23 contas assim — R$ 1.202,40, sendo
-- R$ 909,90 só na Saidera (mesa 32 com R$ 186, mesa 23 com R$ 120, mesa 1 com
-- R$ 89, mesa 9 com R$ 84).
--
-- Decisão do usuário: azul só CONFIRMA. "Se tiver errado ela vai cobrar do
-- garçom e não cancelar."
--
-- O caminho pra conta fechada por engano passa a ser: confirma, e depois
-- estorna a VENDA (cancelar_venda) — que fica registrado, com autor e data,
-- em vez de a comanda evaporar.
--
-- A trava é no banco porque o botão da tela era só um dos caminhos: o app do
-- garçom e uma tela com estado velho chegam na mesma linha.

create or replace function public.trava_cancelar_conta_paga()
returns trigger
language plpgsql
as $$
begin
  if coalesce(old.status, '') = 'aguardando_conferencia' and new.status = 'cancelada' then
    raise exception
      'Esta conta já foi fechada pelo garçom e o dinheiro já foi recebido. Ela só pode ser CONFIRMADA. Se o valor estiver errado, acerte com o garçom — cancelar aqui apagaria uma venda que aconteceu.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists trg_trava_cancelar_conta_paga on public.comandas;
create trigger trg_trava_cancelar_conta_paga
  before update of status on public.comandas
  for each row execute function public.trava_cancelar_conta_paga();
