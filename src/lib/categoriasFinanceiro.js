// ─────────────────────────────────────────────────────────────────────────────
// As categorias de dinheiro da loja — UMA lista só, pro Portal e pro robô.
//
// Estavam dentro do ContasPagarReceber.jsx, e o robô do WhatsApp tinha a dele
// copiada na edge function. Duas listas sempre viram sinônimos ("Limpeza",
// "Limpeza e higiene", "Produtos de limpeza") e o relatório por categoria nasce
// dividido. Agora quem muda aqui muda nos dois.
//
// DE COMPRA = o que pode aparecer numa nota de fornecedor. É só essas que o
// robô pode escolher sozinho ao ler o papel — classificar uma nota como
// "Aluguel" nunca é o certo.
// DE OPERAÇÃO = o resto do que sai todo mês, lançado na mão (ou pelo robô
// quando o dono escreve "paguei 300 de energia").
// ─────────────────────────────────────────────────────────────────────────────

export const CATEGORIAS_COMPRA = [
  'Hortifruti',
  'Carnes e frios',
  'Laticínios e ovos',
  'Mercearia',
  'Padaria e confeitaria',
  'Congelados',
  'Bebidas',
  'Descartáveis e embalagens',
  'Limpeza e higiene',
  'Gás',
  'Equipamentos e utensílios',
  'Manutenção',
]

export const CATEGORIAS_OPERACAO = [
  'Fornecedores',
  'Aluguel',
  'Energia',
  'Água',
  'Internet e telefone',
  'Salários e encargos',
  'Pró-labore',
  'Impostos e taxas',
  'Contabilidade',
  'Maquininha e taxas',
  'Taxas de aplicativos',
  'Combustível e entrega',
  'Frete',
  'Marketing',
  'Aplicativos e sistemas',
  'Uniformes e EPI',
  'Licenças e alvarás',
  'Seguros',
  'Empréstimos',
  'Retiradas do dono',
  'Outros',
]

export const CATEGORIAS_PAGAR = [...CATEGORIAS_COMPRA, ...CATEGORIAS_OPERACAO]

/**
 * A chave do item, igualzinha à do robô (ler-nota-estoque): as DUAS primeiras
 * palavras, sem acento e sem pontuação.
 *
 * "DET ABSOLUTO 400G" e "DET ABSOLUTO 500G" são o mesmo produto pro dono da
 * loja. Se a correção dele casasse pela descrição inteira, na semana seguinte
 * (embalagem maior, mesmo produto) o robô erraria de novo.
 */
export function chaveDoItem(desc) {
  return String(desc ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/ +/g, ' ').trim()
    .split(' ').slice(0, 2).join(' ')
}

export const CATEGORIAS_RECEBER = [
  'Venda a prazo',
  'Fiado de cliente',
  'Repasse iFood',
  'Repasse cartão',
  'Repasse PIX',
  'Aluguel recebido',
  'Empréstimo a receber',
  'Venda de equipamento',
  'Devolução de fornecedor',
  'Outros',
]
