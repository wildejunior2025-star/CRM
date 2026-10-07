-- A tela de Repasses passa a ser igual à do portal do iFood: uma linha por
-- período de apuração. A data boa (quando o dinheiro CAI) só existe na API de
-- antecipação — a de Settlements devolve o prazo normal, D+30, que confundia
-- o lojista ("previsão 28/10" numa semana que ele já recebeu dia 07/10).
alter table ifood_liquidacao_semanas
  add column if not exists antecipacao_itens jsonb;

comment on column ifood_liquidacao_semanas.antecipacao_itens is
  'Um item por período antecipado: periodo_ini, periodo_fim, pagamento (data real), taxa, liquido, subtotal e o bruto do iFood.';
