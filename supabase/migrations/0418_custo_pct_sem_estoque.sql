-- 0418 — PRODUTO COM CUSTO EM % NÃO CONTROLA ESTOQUE
--
-- 27/10/2026, regra do Wilde: "tudo que tiver custo de 40% não tem que ter estoque". Custo em % do preço
-- (custo_pct_venda) é coisa de prato feito na cozinha — quentinha, refeição, suco, self-service. Não existe
-- "chegaram 50 quentinhas": o produto só tinha saída e ficava negativo (AGV: Self-service −64). O estoque
-- desses pratos é o dos INSUMOS (Cozinha / Contagem).
--
-- A regra só age quando o custo em % é DEFINIDO (produto novo, ou alguém muda o %). Quem depois religar o
-- estoque na mão, sem mexer no %, fica como escolheu.
--
-- Backfill: desliga em quem tem % e nunca recebeu entrada. Fica de fora quem já teve entrada lançada
-- (Zebu: Açaí 500ml) — alguém controla aquilo de propósito.

create or replace function trg_produto_custo_pct_sem_estoque() returns trigger
language plpgsql as $$
begin
  if coalesce(new.custo_pct_venda, 0) > 0
     and (tg_op = 'INSERT' or new.custo_pct_venda is distinct from old.custo_pct_venda) then
    new.controla_estoque := false;
  end if;
  return new;
end $$;

drop trigger if exists produto_custo_pct_sem_estoque on produtos;
create trigger produto_custo_pct_sem_estoque before insert or update of custo_pct_venda on produtos
  for each row execute function trg_produto_custo_pct_sem_estoque();

update produtos p set controla_estoque = false
 where coalesce(p.custo_pct_venda, 0) > 0
   and coalesce(p.controla_estoque, true)
   and not exists (select 1 from estoque_movimentos m where m.produto_id = p.id and m.tipo = 'entrada');
