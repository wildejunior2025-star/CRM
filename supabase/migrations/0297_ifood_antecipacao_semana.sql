-- Loja com antecipação (a Zebu paga 0,25%, a Estação uma taxa fixa de R$ 4,90)
-- recebe menos que o valor apurado: o portal mostra "subtotal", "taxa de
-- antecipação" e "valor". Guardamos os três pra tela dizer o que realmente cai
-- na conta, e não só o que o iFood apurou.
alter table ifood_liquidacao_semanas
  add column if not exists antecipacao_taxa numeric(12,2),
  add column if not exists antecipado numeric(12,2);

comment on column ifood_liquidacao_semanas.antecipacao_taxa is 'Taxa cobrada pela antecipação na semana (soma dos feeAmount da API Anticipations).';
comment on column ifood_liquidacao_semanas.antecipado is 'Valor efetivamente transferido depois da antecipação (balance da API Anticipations).';
