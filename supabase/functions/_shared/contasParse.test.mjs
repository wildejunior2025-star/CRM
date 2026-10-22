// node --experimental-strip-types supabase/functions/_shared/contasParse.test.mjs
import { lerComandoConta, extrairData, extrairValor } from './contasParse.ts'
const norm = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const HOJE = '2026-10-22'   // quinta-feira
let falhas = 0
const esperar = (frase, esperado) => {
  const r = lerComandoConta(norm(frase), HOJE)
  const ok = esperado === null ? r === null : r && Object.entries(esperado).every(([k, v]) => JSON.stringify(r[k]) === JSON.stringify(v))
  if (!ok) { falhas++; console.log('FALHOU:', frase, '\n  esperado', JSON.stringify(esperado), '\n  veio    ', JSON.stringify(r)) }
}
// pagou hoje
esperar('paguei 80 de gás', { acao: 'paguei', valor: 80, descricao: 'Gas', categoria: 'Gás', vencimento: null })
esperar('Paguei gás 80', { acao: 'paguei', valor: 80, descricao: 'Gas' })
esperar('paguei a luz 350,50 no pix', { acao: 'paguei', valor: 350.5, descricao: 'Luz', forma: 'pix', categoria: 'Energia' })
esperar('paguei 1.200,00 de aluguel', { acao: 'paguei', valor: 1200, descricao: 'Aluguel', categoria: 'Aluguel' })
esperar('paguei 150 reais pro zé do gás', { acao: 'paguei', valor: 150 })
esperar('paguei 45 de internet em dinheiro', { acao: 'paguei', valor: 45, forma: 'dinheiro', categoria: 'Internet e telefone' })
esperar('paguei 200 para o fornecedor carlos', { acao: 'paguei', valor: 200, pessoa: 'Carlos' })
// lançar conta a pagar
esperar('a pagar luz 350 dia 28', { acao: 'pagar', valor: 350, descricao: 'Luz', vencimento: '2026-10-28' })
esperar('conta a pagar aluguel 2200 vence 05/11', { acao: 'pagar', valor: 2200, vencimento: '2026-11-05', categoria: 'Aluguel' })
esperar('pagar fornecedor joão 1500 dia 10', { acao: 'pagar', valor: 1500, vencimento: '2026-11-10' })
esperar('a pagar internet 119,90 todo mês dia 15', { acao: 'pagar', valor: 119.9, recorrencia: 'mensal', vencimento: '2026-11-15' })
esperar('vou pagar 300 de manutenção amanhã', { acao: 'pagar', valor: 300, vencimento: '2026-10-23', categoria: 'Manutenção' })
esperar('a pagar 90 de gás sexta', { acao: 'pagar', valor: 90, vencimento: '2026-10-23' })
esperar('a pagar energia 400 em 5 dias', { acao: 'pagar', valor: 400, vencimento: '2026-10-27' })
esperar('a pagar luz 350', { acao: 'pagar', valor: 350, vencimento: null })
// receber
esperar('recebi 200 do joão', { acao: 'recebi', valor: 200, pessoa: 'Joao' })
esperar('joão pagou 200', { acao: 'recebi', valor: 200, pessoa: 'Joao' })
esperar('a receber joão 200 dia 30', { acao: 'receber', valor: 200, vencimento: '2026-10-30' })
esperar('joão vai pagar 200 dia 30', { acao: 'receber', valor: 200, pessoa: 'Joao', vencimento: '2026-10-30' })
esperar('a receber 3120,40 do ifood dia 27', { acao: 'receber', valor: 3120.4, pessoa: 'Ifood', vencimento: '2026-10-27', categoria: 'Repasse iFood' })
esperar('recebi 960 da clínica vida', { acao: 'recebi', valor: 960, pessoa: 'Clinica Vida' })
// não é conta
esperar('comprei 20 kg de queijo a 30', null)
esperar('vendas hoje', null)
esperar('lista o estoque', null)
esperar('quanto devo pagar', null)
esperar('paguei', null)
// acentos e nomes
{
  const orig = 'Recebi 200 do João'
  const r = lerComandoConta(norm(orig), HOJE, orig)
  if (!r || r.descricao !== 'Recebimento de João' || r.pessoa !== 'João') { falhas++; console.log('ACENTO FALHOU:', JSON.stringify(r)) }
  const o2 = 'Paguei 80 de gás'
  const r2 = lerComandoConta(norm(o2), HOJE, o2)
  if (!r2 || r2.descricao !== 'Gás') { falhas++; console.log('ACENTO 2 FALHOU:', JSON.stringify(r2)) }
}
// datas
const d = (t) => extrairData(` ${t} `, HOJE).data
const eq = (a, b, n) => { if (a !== b) { falhas++; console.log('DATA FALHOU:', n, a, '!=', b) } }
eq(d('dia 22'), '2026-10-22', 'dia 22 (hoje)')
eq(d('dia 21'), '2026-11-21', 'dia 21 (passou → mês que vem)')
eq(d('vence 31/12'), '2026-12-31', '31/12')
eq(d('28/02'), '2027-02-28', '28/02 sem ano, passou há mais de 60 dias? não: é futuro no mesmo ano')
eq(d('depois de amanhã'.normalize('NFD').replace(/[̀-ͯ]/g, '')), '2026-10-24', 'depois de amanha')
eq(d('segunda'), '2026-10-26', 'segunda')
eq(d('quinta'), '2026-10-29', 'quinta (hoje é quinta → a próxima)')
// valores
const v = (t) => extrairValor(t).valor
eq(v('1.200'), 1200, '1.200'); eq(v('1.200,50'), 1200.5, '1.200,50'); eq(v('80,5'), 80.5, '80,5'); eq(v('r$ 12'), 12, 'r$ 12'); eq(v('350 reais'), 350, '350 reais')
console.log(falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} falha(s)`)
process.exit(falhas ? 1 : 0)
