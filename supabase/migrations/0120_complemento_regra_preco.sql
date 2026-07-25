-- Como o grupo de complemento cobra as opções escolhidas.
--
-- 'somar'  (padrão, comportamento de sempre): cada opção escolhida soma no
--          preço. É o certo pra adicional de lanche, borda, bebida.
--
-- 'maior'  pizza meio a meio: vale só a opção MAIS CARA do grupo. Os sabores
--          entram com o preço cheio de cada um, então:
--            Especial R$45 + Promoção R$30,99 → R$ 45,00
--            Promoção R$30,99 + Promoção R$30,99 → R$ 30,99
--          Sem isso o sistema somaria os dois (R$ 75,99) e a pizza sairia pelo
--          dobro.
--
-- A regra é por GRUPO, então um mesmo produto pode ter o grupo de sabores
-- cobrando pelo maior e o grupo de borda/bebida somando normal.

alter table public.complemento_grupos
  add column if not exists regra_preco text not null default 'somar';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'complemento_grupos_regra_preco_check'
  ) then
    alter table public.complemento_grupos
      add constraint complemento_grupos_regra_preco_check
      check (regra_preco in ('somar', 'maior'));
  end if;
end $$;

comment on column public.complemento_grupos.regra_preco is
  'somar = cada opção soma no preço (padrão); maior = vale só a opção mais cara do grupo (pizza meio a meio)';
