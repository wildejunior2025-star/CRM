-- COMANDA FECHADA NÃO ACEITA MAIS MUDANÇA (11/10/2026)
--
-- O relato da Saidera era "a conta volta depois de fechada, com o mesmo valor
-- e os mesmos itens, sendo que já tinha dado baixa". Procurando, achei que
-- NADA reabre comanda — não existe código, no front nem no banco, que devolva
-- o status pra 'aberta'. Mas achei outra coisa: item sendo LANÇADO em comanda
-- já fechada. Cinco casos em 30 dias na Saidera (R$ 49,00 no total), de 0 a 13
-- minutos depois do fechamento — inclusive na mesa 31 do relato original.
--
-- A venda já tinha sido gerada, então esses itens NUNCA foram cobrados: saíram
-- do estoque e não entraram em caixa. E a comanda fica com itens que não batem
-- com o total dela.
--
-- A tela já avisava ("Conta já fechada, aguardando o ADM liberar"), mas os
-- cinco passaram por fora dela — tela aberta com estado velho, ou o QR da mesa
-- lançando num id que já tinha fechado. Por isso a trava é no BANCO: não tem
-- caminho que escape.
--
-- O QUE CONTINUA PASSANDO: a cozinha marcando pronto/entregue. O papel sai
-- antes de o prato ficar pronto, então status tem que poder mudar depois do
-- fechamento. Trava só o que mexe no DINHEIRO: item novo, item apagado,
-- quantidade e preço.
--
-- Cascata (excluir_empresa_completa) tem guarda: se a comanda já sumiu junto,
-- não é edição e passa.

create or replace function public.trava_comanda_fechada()
returns trigger
language plpgsql
as $$
declare
  v_id uuid := coalesce(new.comanda_id, old.comanda_id);
  v_status text;
begin
  select status into v_status from comandas where id = v_id;
  if not found then return coalesce(new, old); end if;
  if v_status = 'aberta' then return coalesce(new, old); end if;

  if tg_op = 'UPDATE'
     and new.quantidade     is not distinct from old.quantidade
     and new.preco_unitario is not distinct from old.preco_unitario
     and new.comanda_id     is not distinct from old.comanda_id then
    return new;
  end if;

  raise exception
    'Esta comanda já foi fechada e não aceita mais mudança. Abra uma comanda nova pra lançar.'
    using errcode = 'P0001';
end $$;

drop trigger if exists trg_trava_comanda_fechada on public.comanda_itens;
create trigger trg_trava_comanda_fechada
  before insert or update or delete on public.comanda_itens
  for each row execute function public.trava_comanda_fechada();
