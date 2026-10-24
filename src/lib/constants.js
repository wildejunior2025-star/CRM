// Formas que o cliente usa PRA PAGAR — as únicas do dia a dia da loja.
// É esta lista que aparece em Minha Loja → Pagamento e nos botões da Nova venda
// e do checkout da Loja Online. Marcar/desmarcar aqui liga/desliga o botão lá.
// Os dois PIX são coisas diferentes:
//   pix         → cobrança online (Mercado Pago). O cliente paga ANTES, o pedido
//                 só cai na loja depois de confirmado. Exige MP conectado e tem taxa.
//   pix_entrega → o cliente paga na hora da entrega, direto na chave PIX da loja.
//                 Não passa por gateway nenhum: sem taxa e sem conectar o MP.
// Crédito e débito são separados porque a maquineta cobra taxa diferente em cada
// um (decisão do Wilde, 10/08/2026) — só assim dá pra saber quanto cai na conta.
// "Cartão" continua na lista: é o que está gravado no histórico e serve pra loja
// que não quer separar.
// Cartões de benefício (vale-refeição / vale-alimentação, mig 0385). Cada bandeira
// é uma forma própria, porque cada uma é uma maquineta, um repasse e uma conciliação
// diferentes. `optIn`: NASCEM DESLIGADAS — só aparecem na loja que ligar em Minha
// Loja → Pagamento (a Agv liga; o resto do mundo nem vê).
export const FORMAS_VALE = [
  { value: 'pluxee', label: 'Pluxee', optIn: true },
  { value: 'alelo',  label: 'Alelo',  optIn: true },
  { value: 'vr',     label: 'VR',     optIn: true },
  { value: 'ticket', label: 'Ticket', optIn: true },
]
export const ehVale = (forma) => FORMAS_VALE.some(f => f.value === forma)

export const FORMAS_PAGAMENTO = [
  { value: 'dinheiro',    label: 'Dinheiro' },
  { value: 'pix',         label: 'PIX' },
  { value: 'pix_entrega', label: 'PIX na entrega' },
  { value: 'credito',     label: 'Cartão de crédito' },
  { value: 'debito',      label: 'Cartão de débito' },
  { value: 'cartao',      label: 'Cartão (sem separar)' },
  ...FORMAS_VALE,
]

// Formas de cartão e em qual coluna de empresas mora a taxa de cada uma.
// `campoTaxa` é o que a MAQUINETA desconta da loja (alimenta o "cai na conta" do
// Caixa). `campoRepasse` é o acréscimo que a loja cobra DO CLIENTE no cardápio
// online (mig 0223) — os dois são independentes de propósito: a Estação usa só
// a taxa, pro controle do caixa; a CD Bom cobra 5% no crédito do cliente.
export const FORMAS_CARTAO = [
  { value: 'credito', label: 'Cartão de crédito', campoTaxa: 'taxa_credito_pct', campoRepasse: 'repasse_credito_pct' },
  { value: 'debito',  label: 'Cartão de débito',  campoTaxa: 'taxa_debito_pct',  campoRepasse: 'repasse_debito_pct' },
  { value: 'cartao',  label: 'Cartão (sem separar)', campoTaxa: 'taxa_cartao_pct', campoRepasse: 'repasse_cartao_pct' },
]

/** Quanto a loja cobra a mais do cliente nesta forma (%). 0 = sem acréscimo. */
export function repassePct(empresa, forma) {
  const f = FORMAS_CARTAO.find(x => x.value === forma)
  if (!f) return 0
  const v = Number(empresa?.[f.campoRepasse] ?? 0)
  return Number.isFinite(v) && v > 0 ? v : 0
}
export const ehCartao = (forma) => ['credito', 'debito', 'cartao'].includes(forma)
// Padrão de loja que nunca configurou: tudo, MENOS o que é opt-in (vales).
export const FORMAS_PAGAMENTO_PADRAO = FORMAS_PAGAMENTO.filter(f => !f.optIn).map(f => f.value)
const TODAS_AS_FORMAS = FORMAS_PAGAMENTO.map(f => f.value)

/** As formas ligadas na loja (com o padrão quando nunca foi configurado). */
export function formasAtivas(empresa) {
  const salvas = (empresa?.formas_pagamento ?? []).filter(v => TODAS_AS_FORMAS.includes(v))
  return salvas.length ? salvas : FORMAS_PAGAMENTO_PADRAO
}

/** Só os vales ligados na loja (pra telas que listam as formas na mão). */
export const valesAtivos = (empresa) => FORMAS_VALE.filter(f => formasAtivas(empresa).includes(f.value))

// CONDIÇÃO de pagamento do CLIENTE (à vista, fiado, prazo) — é outra coisa:
// define como aquele cliente compra, não a máquina/meio usado no caixa.
// 254 clientes já usam esses valores, então a lista continua inteira.
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
  cartao:             { bg: '#7c3aed', text: '#fff', label: '💳' },
  credito:            { bg: '#7c3aed', text: '#fff', label: 'CRÉD' },
  debito:             { bg: '#0ea5e9', text: '#fff', label: 'DÉB' },
  a_vista:            { bg: '#16a34a', text: '#fff', label: '$' },
  fiado:              { bg: '#f97316', text: '#fff', label: 'F' },
  dinheiro:           { bg: '#16a34a', text: '#fff', label: '💵' },
  pix:                { bg: '#00b4d8', text: '#fff', label: 'PIX' },
  pix_entrega:        { bg: '#0891b2', text: '#fff', label: 'PIX' },
  pluxee:             { bg: '#0f766e', text: '#fff', label: 'PLX' },
  alelo:              { bg: '#15803d', text: '#fff', label: 'ALE' },
  vr:                 { bg: '#be123c', text: '#fff', label: 'VR' },
  ticket:             { bg: '#b91c1c', text: '#fff', label: 'TKT' },
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
  { value: 'credito', label: 'Crédito' },
  { value: 'debito', label: 'Débito' },
  { value: 'cartao', label: 'Cartão' },
]
