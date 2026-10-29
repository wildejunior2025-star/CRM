-- Ajuste da distancia pela rua (28/10/2026).
--
-- Com a taxa pela rua ligada em todas as lojas (0423), as faixas de km que
-- foram montadas na LINHA RETA cobravam 9% a 19% a mais. O Wilde pediu pra
-- ficar "aproximadamente o que ja era, e eles melhoram depois".
--
-- Esticar as faixas nao serve: a mesma tabela paga o motoboy
-- (calcular_valor_entregador) e alimenta robo e + Vender, que medem em reta —
-- todos iam cair junto. Entao a tabela fica igual e, SO na cobranca pela rua,
-- os km da rua sao divididos por este fator (quanto a rua da a mais que a reta
-- naquela loja). Fator 1 = cobra o km exato da rua.
--
-- Medido em 28/10 em entregas reais: Zebu 1,42 / CDBom 1,46 / Mickey 1,47 /
-- Marajo 1,31. Sem entregas pra medir: 1,4 (media delas). Loja nova nasce com 1:
-- ela ja monta as faixas pensando no km da rua.
alter table public.empresas add column if not exists fator_rua numeric not null default 1
  check (fator_rua >= 1 and fator_rua <= 3);

update public.empresas set fator_rua = 1.4;
update public.empresas set fator_rua = 1.42 where id = '8086398c-04e5-4ba4-927a-936edf15cc20'; -- Zebu
update public.empresas set fator_rua = 1.46 where id = 'a95b716b-d973-42ab-ace9-dae0fd1acd62'; -- CDBom
update public.empresas set fator_rua = 1.47 where id = 'f1aaed32-3542-4f3a-abc3-6da3a90e5b8b'; -- Mickey
update public.empresas set fator_rua = 1.31 where id = '129d48c6-70af-43bb-94f2-98604f245c54'; -- Marajo
