-- ─────────────────────────────────────────────────────────────────────────────
-- 0389 — A nota quebrada por categoria (rateio)
--
-- 24/10/2026: o robô concorrente lê o cupom e mostra em QUE o dinheiro foi:
-- "Alimentos R$ 92,29 · Limpeza R$ 18,07". O nosso lançava tudo como
-- "Fornecedores" — certo pra pagar, inútil pra saber onde o dinheiro vai.
--
-- UMA conta por nota, não uma por categoria: a nota é UM pagamento ao MESMO
-- fornecedor. Quebrar em duas contas dobraria a linha no Contas a pagar e
-- pediria duas baixas pra uma dívida só. O detalhe vive aqui dentro.
--
-- Formato: [{"categoria": "Alimentos", "valor": 92.29}, ...], somando o valor
-- da conta. Vazio/null = conta sem rateio (todas as de antes, e as que o robô
-- não conseguiu separar).
-- ─────────────────────────────────────────────────────────────────────────────

alter table contas_financeiras
  add column if not exists rateio jsonb;

comment on column contas_financeiras.rateio is
  'Quebra do valor por categoria de gasto: [{categoria, valor}], somando o valor da conta. Null = sem rateio.';
