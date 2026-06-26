export const CONDICOES_PAGAMENTO = [
  { value: 'a_vista',             label: 'À vista' },
  { value: 'fiado',               label: 'Fiado' },
  { value: 'dinheiro',            label: 'Dinheiro' },
  { value: 'pix',                 label: 'PIX' },
  { value: 'visa_debito',         label: 'Visa - Débito' },
  { value: 'mastercard_debito',   label: 'Mastercard - Débito' },
  { value: 'elo_debito',          label: 'Elo - Débito' },
  { value: 'hipercard_credito',   label: 'Hipercard - Crédito' },
  { value: 'mastercard_credito',  label: 'Mastercard - Crédito' },
  { value: 'visa_credito',        label: 'Visa - Crédito' },
  { value: 'elo_credito',         label: 'Elo - Crédito' },
  { value: 'amex_credito',        label: 'Amex - Crédito' },
  { value: 'boleto_7d',           label: 'Boleto 7 dias' },
  { value: 'boleto_14d',          label: 'Boleto 14 dias' },
  { value: 'boleto_30d',          label: 'Boleto 30 dias' },
]

export const ICONE_PAGAMENTO = {
  a_vista:            { bg: '#16a34a', text: '#fff', label: '$' },
  fiado:              { bg: '#f97316', text: '#fff', label: 'F' },
  dinheiro:           { bg: '#16a34a', text: '#fff', label: '💵' },
  pix:                { bg: '#00b4d8', text: '#fff', label: 'PIX' },
  visa_debito:        { bg: '#1a1f71', text: '#fff', label: 'VISA' },
  mastercard_debito:  { bg: '#eb001b', text: '#fff', label: 'MC' },
  elo_debito:         { bg: '#000', text: '#ffd700', label: 'elo' },
  hipercard_credito:  { bg: '#c41b16', text: '#fff', label: 'H' },
  mastercard_credito: { bg: '#eb001b', text: '#fff', label: 'MC' },
  visa_credito:       { bg: '#1a1f71', text: '#fff', label: 'VISA' },
  elo_credito:        { bg: '#000', text: '#ffd700', label: 'elo' },
  amex_credito:       { bg: '#2e77bc', text: '#fff', label: 'AMEX' },
  boleto_7d:          { bg: '#6b7280', text: '#fff', label: 'BOL' },
  boleto_14d:         { bg: '#6b7280', text: '#fff', label: 'BOL' },
  boleto_30d:         { bg: '#6b7280', text: '#fff', label: 'BOL' },
}

export const STATUS_VENDA = [
  { value: 'pedido', label: 'Pedido' },
  { value: 'entregue', label: 'Entregue' },
  { value: 'cancelado', label: 'Cancelado' },
]

export const FORMAS_RECEBIMENTO = [
  { value: 'dinheiro', label: 'Dinheiro' },
  { value: 'pix', label: 'Pix' },
  { value: 'transferencia', label: 'Transferência' },
  { value: 'cartao', label: 'Cartão' },
]
