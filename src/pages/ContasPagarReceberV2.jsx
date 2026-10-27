import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { recadoDeErro } from '../lib/erroRede'
import { CATEGORIAS_PAGAR, CATEGORIAS_RECEBER } from '../lib/categoriasFinanceiro'
import { useConfirmar } from '../hooks/useConfirmar'
import {
  brl, ymd, somaDias, somaMeses, situacaoDe, restanteDe, quandoTexto,
  FormConta, ModalBaixa, ModalHistorico,
} from './ContasPagarReceber'
import '../components/Page.css'
import './ContasPagarReceber.css'
import './ContasPagarReceberV2.css'

// CONTAS — A PAGAR, A RECEBER E JÁ PAGO, ARRUMADO (26/10/2026)
//
// A tela antiga (ContasPagarReceber) juntava num lugar só 5 cartões, um gráfico, o fiado, a lista de
// categorias, 3 filtros e a lista de contas. O Wilde, vendo a do AGV: "poluído e misturado — a pessoa
// tem que entender só de olhar". Aqui cada pergunta tem a sua aba:
//
//   A pagar  → o que vence, em blocos por prazo (atrasadas, hoje, 7 dias, 30 dias…)
//   A receber→ o mesmo, pro que vai entrar
//   Já pago  → pra ONDE foi o dinheiro: famílias (mercadoria, fixos, pessoal…) com as categorias dentro
//
// Nada de filtro escondendo conta: cada aba mostra TUDO o que é dela. Os dados, o pagar/editar/excluir
// e os modais são os mesmos da tela antiga (mesmas tabelas, mesmas regras do banco, mig 0365).
//
// CAIXA, não lucro: pagar uma compra aqui não mexe no "Lucro real do dia". O custo da mercadoria já
// entra no lucro pela ficha técnica quando ela é vendida; descontar a compra também seria contar duas vezes.

const FAMILIAS = [
  { id: 'mercadoria', rotulo: 'Mercadoria', emoji: '🛒', cor: '#2563eb', dica: 'o que você compra pra vender ou cozinhar' },
  { id: 'material', rotulo: 'Material e manutenção', emoji: '🧹', cor: '#0891b2', dica: 'embalagem, limpeza, gás, conserto' },
  { id: 'fixos', rotulo: 'Fixos do negócio', emoji: '🏠', cor: '#7c3aed', dica: 'aluguel, luz, água, internet' },
  { id: 'pessoal', rotulo: 'Pessoal', emoji: '👥', cor: '#db2777', dica: 'salários e retiradas' },
  { id: 'impostos', rotulo: 'Impostos, taxas e entrega', emoji: '🧾', cor: '#ea580c', dica: 'imposto, maquininha, aplicativo, frete' },
  { id: 'outros', rotulo: 'Outros', emoji: '📦', cor: '#64748b', dica: 'o que não se encaixa nos outros' },
]
const FAMILIA_DA = {
  'Descartáveis e embalagens': 'material', 'Limpeza e higiene': 'material', 'Gás': 'material',
  'Equipamentos e utensílios': 'material', 'Manutenção': 'material', 'Uniformes e EPI': 'material',
  'Aluguel': 'fixos', 'Energia': 'fixos', 'Água': 'fixos', 'Internet e telefone': 'fixos', 'Contabilidade': 'fixos',
  'Aplicativos e sistemas': 'fixos', 'Seguros': 'fixos', 'Licenças e alvarás': 'fixos', 'Marketing': 'fixos',
  'Salários e encargos': 'pessoal', 'Pró-labore': 'pessoal', 'Retiradas do dono': 'pessoal',
  'Impostos e taxas': 'impostos', 'Maquininha e taxas': 'impostos', 'Taxas de aplicativos': 'impostos',
  'Combustível e entrega': 'impostos', 'Frete': 'impostos', 'Empréstimos': 'impostos',
  'Outros': 'outros', 'Sem categoria': 'outros',
}
// Categoria que ninguém classificou (inclusive as do catálogo: Picolé, Sucos…) é mercadoria: é o que a loja revende.
const familiaDe = (cat) => FAMILIAS.find(f => f.id === (FAMILIA_DA[cat] || 'mercadoria'))

const PRAZOS = [
  ['atrasadas', 'Atrasadas', '#dc2626'],
  ['hoje', 'Vence hoje', '#ea580c'],
  ['semana', 'Próximos 7 dias', '#ca8a04'],
  ['mes', 'Até 30 dias', '#2563eb'],
  ['depois', 'Mais pra frente', '#64748b'],
]
function prazoDe(c, hoje) {
  if (c.vencimento < hoje) return 'atrasadas'
  if (c.vencimento === hoje) return 'hoje'
  if (c.vencimento <= somaDias(hoje, 7)) return 'semana'
  if (c.vencimento <= somaDias(hoje, 30)) return 'mes'
  return 'depois'
}

const doMes = (c, mes) => String(c.pago_em || c.vencimento || '').slice(0, 7) === mes

export default function ContasPagarReceberV2({ empresaId, onAbrirFiado, onTelaAntiga }) {
  const [confirmar, avisoConfirmar] = useConfirmar()
  const [contas, setContas] = useState([])
  const [fiado, setFiado] = useState({ total: 0, clientes: 0, lista: [] })
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [aba, setAba] = useState('pagar')               // 'pagar' | 'receber' | 'pago'
  const [periodo, setPeriodo] = useState('mes')         // só na aba "Já pago"
  const [catAberta, setCatAberta] = useState(null)      // categoria aberta na aba "Já pago"
  const [form, setForm] = useState(null)
  const [baixaDe, setBaixaDe] = useState(null)
  const [historicoDe, setHistoricoDe] = useState(null)
  const [menuAberto, setMenuAberto] = useState(null)
  const [clientes, setClientes] = useState([])

  const hoje = ymd(new Date())
  const mesAtual = hoje.slice(0, 7)
  const mesPassado = somaMeses(`${mesAtual}-01`, -1, 1).slice(0, 7)

  const avisar = useCallback((tipo, texto) => {
    setAviso({ tipo, texto })
    setTimeout(() => setAviso((a) => (a && a.texto === texto ? null : a)), 5000)
  }, [])

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setErro(null)
    try {
      // Abertas: todas. Quitadas: só dos últimos 180 dias.
      const corte = somaDias(ymd(new Date()), -180)
      const dados = await fetchAll(() => supabase.from('contas_financeiras').select('*')
        .eq('empresa_id', empresaId)
        .or(`status.eq.aberta,vencimento.gte.${corte}`)
        .order('vencimento').order('created_at').order('id'))
      if (dados.error) throw dados.error
      setContas(dados.data || [])
      const f = await supabase.from('clientes_saldo_fiado').select('cliente_id, saldo_fiado')
      const devedores = (f.data || []).filter((x) => Number(x.saldo_fiado) > 0)
      // Os nomes: a visão de saldo só traz cliente_id e valor.
      let lista = []
      if (devedores.length) {
        const nomes = await supabase.from('clientes').select('id, nome').in('id', devedores.map((x) => x.cliente_id))
        const mapa = new Map((nomes.data || []).map((c) => [c.id, (c.nome || '').trim()]))
        lista = devedores.map((x) => ({ id: x.cliente_id, nome: mapa.get(x.cliente_id) || 'Cliente sem nome', saldo: Number(x.saldo_fiado) }))
          .sort((a, b) => b.saldo - a.saldo)
      }
      setFiado({ total: devedores.reduce((s, x) => s + Number(x.saldo_fiado), 0), clientes: devedores.length, lista })
    } catch (e) {
      setErro(recadoDeErro(e, 'carregar as contas'))
    } finally {
      setCarregando(false)
    }
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])
  useEffect(() => {
    if (!form || clientes.length) return
    fetchAll(() => supabase.from('clientes').select('nome').order('nome').order('id'))
      .then((r) => setClientes([...new Set((r.data || []).map((c) => (c.nome || '').trim()).filter(Boolean))]))
      .catch(() => {})
  }, [!!form]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!menuAberto) return
    const fechar = () => setMenuAberto(null)
    document.addEventListener('click', fechar)
    return () => document.removeEventListener('click', fechar)
  }, [menuAberto])

  // ── números do topo ──
  const resumo = useMemo(() => {
    const abertas = contas.filter((c) => c.status === 'aberta')
    const soma = (l) => l.reduce((s, c) => s + restanteDe(c), 0)
    const pagar = abertas.filter((c) => c.tipo === 'pagar')
    const receber = abertas.filter((c) => c.tipo === 'receber')
    const atrasPagar = pagar.filter((c) => c.vencimento < hoje)
    const pagasMes = contas.filter((c) => c.tipo === 'pagar' && Number(c.valor_pago) > 0 && doMes(c, mesAtual))
    const recebidasMes = contas.filter((c) => c.tipo === 'receber' && Number(c.valor_pago) > 0 && doMes(c, mesAtual))
    const pagoHoje = contas.filter((c) => c.tipo === 'pagar' && Number(c.valor_pago) > 0 && c.pago_em === hoje)
    const v = (l) => l.reduce((s, c) => s + Number(c.valor_pago || 0), 0)
    return {
      nPagar: pagar.length, totalPagar: soma(pagar), nAtras: atrasPagar.length, atrasPagar: soma(atrasPagar),
      nReceber: receber.length, totalReceber: soma(receber), atrasReceber: soma(receber.filter((c) => c.vencimento < hoje)),
      pagoMes: v(pagasMes), nPagoMes: pagasMes.length, pagoHoje: v(pagoHoje),
      recebidoMes: v(recebidasMes),
    }
  }, [contas, hoje, mesAtual])

  // ── abas "A pagar" e "A receber": blocos por prazo ──
  const blocos = useMemo(() => {
    if (aba === 'pago') return []
    const abertas = contas.filter((c) => c.status === 'aberta' && c.tipo === aba)
    return PRAZOS.map(([id, rotulo, cor]) => {
      const itens = abertas.filter((c) => prazoDe(c, hoje) === id).sort((a, b) => a.vencimento.localeCompare(b.vencimento))
      return { id, rotulo, cor, itens, total: itens.reduce((s, c) => s + restanteDe(c), 0) }
    }).filter((b) => b.itens.length)
  }, [contas, aba, hoje])

  // ── aba "Já pago": pra onde foi o dinheiro ──
  const pago = useMemo(() => {
    const dentro = (c) => (periodo === 'tudo' ? true : doMes(c, periodo === 'mes' ? mesAtual : mesPassado))
    const lista = contas.filter((c) => c.tipo === 'pagar' && Number(c.valor_pago) > 0 && dentro(c))
      .sort((a, b) => (b.pago_em || b.vencimento).localeCompare(a.pago_em || a.vencimento))
    // Cada conta soma pelo que foi PAGO e, se foi uma nota quebrada por categoria, pelo rateio dela.
    const cats = new Map()
    for (const c of lista) {
      const pagoV = Number(c.valor_pago)
      const fator = Number(c.valor) > 0 ? pagoV / Number(c.valor) : 1
      const r = Array.isArray(c.rateio) ? c.rateio.filter((x) => Number(x?.valor) > 0) : []
      const partes = r.length ? r.map((x) => [x.categoria, Number(x.valor) * fator]) : [[c.categoria || 'Sem categoria', pagoV]]
      for (const [cat, valor] of partes) {
        if (!cats.has(cat)) cats.set(cat, { categoria: cat, valor: 0, contas: [] })
        const g = cats.get(cat)
        g.valor += valor
        if (!g.contas.includes(c)) g.contas.push(c)
      }
    }
    const total = lista.reduce((s, c) => s + Number(c.valor_pago), 0)
    const familias = FAMILIAS.map((f) => {
      const cs = [...cats.values()].filter((g) => familiaDe(g.categoria).id === f.id).sort((a, b) => b.valor - a.valor)
      return { ...f, cats: cs, valor: cs.reduce((s, g) => s + g.valor, 0) }
    }).filter((f) => f.cats.length).sort((a, b) => b.valor - a.valor)
    return { lista, total, familias }
  }, [contas, periodo, mesAtual, mesPassado])

  const sugestoes = useMemo(() => {
    const pessoas = { pagar: new Set(), receber: new Set() }
    const cats = { pagar: new Set(CATEGORIAS_PAGAR), receber: new Set(CATEGORIAS_RECEBER) }
    for (const c of contas) {
      if (c.pessoa) pessoas[c.tipo].add(c.pessoa)
      if (c.categoria) cats[c.tipo].add(c.categoria)
    }
    return { pessoas, cats }
  }, [contas])

  // ── ações (as mesmas da tela antiga) ──
  async function excluir(c) {
    const ok = await confirmar({
      titulo: `Excluir “${c.descricao}”?`,
      texto: c.recorrencia !== 'nenhuma'
        ? 'Apaga só esta conta. As próximas da repetição continuam; se já foi paga, o pagamento some junto.'
        : 'Apaga a conta e os pagamentos dela. Não dá pra desfazer.',
      textoOk: 'Sim, excluir',
    })
    if (!ok) return
    const { error } = await supabase.from('contas_financeiras').delete().eq('id', c.id)
    if (error) { avisar('erro', recadoDeErro(error, 'excluir a conta')); return }
    avisar('ok', 'Conta excluída.')
    carregar()
  }
  const duplicar = (c) => setForm({
    tipo: c.tipo, descricao: c.descricao, pessoa: c.pessoa || '', categoria: c.categoria || '',
    valor: String(c.valor).replace('.', ','), vencimento: somaMeses(c.vencimento, 1, c.dia_ref),
    repeticao: 'nenhuma', parcelas: '2', observacao: c.observacao || '', jaQuitada: false, forma: 'pix',
  })
  const editar = (c) => setForm({
    id: c.id, tipo: c.tipo, descricao: c.descricao, pessoa: c.pessoa || '', categoria: c.categoria || '',
    valor: String(c.valor).replace('.', ','), vencimento: c.vencimento, valorPago: Number(c.valor_pago || 0),
    repeticao: c.recorrencia, parcelas: '2', observacao: c.observacao || '', travadaRepeticao: !!c.parcelas,
  })
  const nova = (tipo) => setForm({
    tipo, descricao: '', pessoa: '', categoria: '', valor: '', vencimento: hoje, repeticao: 'nenhuma', parcelas: '2',
    observacao: '', jaQuitada: false, forma: 'pix',
  })

  if (!empresaId) return <div className="card">Selecione uma loja.</div>

  const linha = (c) => (
    <Linha key={c.id} c={c} hoje={hoje} menuAberto={menuAberto === c.id}
      onMenu={(e) => { e.stopPropagation(); setMenuAberto(menuAberto === c.id ? null : c.id) }}
      onBaixa={() => setBaixaDe(c)} onEditar={() => editar(c)} onDuplicar={() => duplicar(c)}
      onHistorico={() => setHistoricoDe(c)} onExcluir={() => excluir(c)} />
  )

  const semNada = !carregando && !erro && contas.length === 0

  return (
    <div className="cpr cp2">
      {avisoConfirmar}

      <div className="cp2-topo">
        <div>
          <h2 className="cp2-titulo">Contas</h2>
          <p className="cp2-sub">O que você tem pra pagar, pra receber e pra onde o dinheiro já foi.</p>
        </div>
        <div className="cp2-acoes">
          <button type="button" className="btn cpr-btn-pagar" onClick={() => nova('pagar')}>＋ Conta a pagar</button>
          <button type="button" className="btn cpr-btn-receber" onClick={() => nova('receber')}>＋ Conta a receber</button>
        </div>
      </div>

      {aviso && <div className={`cpr-aviso cpr-aviso-${aviso.tipo}`} role="status">{aviso.texto}</div>}
      {erro && <div className="cpr-aviso cpr-aviso-erro" style={{ whiteSpace: 'pre-line' }}>{erro} <button type="button" className="btn btn-secondary btn-sm" onClick={carregar}>Tentar de novo</button></div>}

      {carregando ? (
        <div className="cp2-cards"><div className="skeleton" style={{ height: 92 }} /><div className="skeleton" style={{ height: 92 }} /><div className="skeleton" style={{ height: 92 }} /></div>
      ) : (
        <>
          {/* três números, três perguntas */}
          <div className="cp2-cards">
            <button type="button" className={`cp2-card cp2-card-pagar ${aba === 'pagar' ? 'ativo' : ''}`} onClick={() => setAba('pagar')}>
              <span className="cp2-card-rotulo">💸 A pagar</span>
              <span className="cp2-card-valor">{brl(resumo.totalPagar)}</span>
              <span className={`cp2-card-nota ${resumo.nAtras ? 'cp2-ruim' : 'cp2-bom'}`}>
                {resumo.nAtras ? `⚠️ ${brl(resumo.atrasPagar)} atrasado (${resumo.nAtras})` : resumo.nPagar ? '✓ nada atrasado' : 'nada a pagar'}
              </span>
            </button>
            <button type="button" className={`cp2-card cp2-card-receber ${aba === 'receber' ? 'ativo' : ''}`} onClick={() => setAba('receber')}>
              <span className="cp2-card-rotulo">💰 A receber</span>
              {/* Fiado é dinheiro a receber: entra no total (antes ficava só num aviso e o cartão dizia R$ 0,00). */}
              <span className="cp2-card-valor">{brl(resumo.totalReceber + fiado.total)}</span>
              <span className={`cp2-card-nota ${resumo.atrasReceber ? 'cp2-ruim' : ''}`}>
                {resumo.atrasReceber ? `⚠️ ${brl(resumo.atrasReceber)} atrasado` : fiado.total > 0
                  ? `🧾 inclui ${brl(fiado.total)} de fiado (${fiado.clientes} ${fiado.clientes === 1 ? 'cliente' : 'clientes'})`
                  : resumo.nReceber ? `${resumo.nReceber} ${resumo.nReceber === 1 ? 'conta' : 'contas'}` : 'nada a receber'}
              </span>
            </button>
            <button type="button" className={`cp2-card cp2-card-pago ${aba === 'pago' ? 'ativo' : ''}`} onClick={() => { setAba('pago'); setPeriodo('mes') }}>
              <span className="cp2-card-rotulo">✅ Saiu este mês</span>
              <span className="cp2-card-valor">{brl(resumo.pagoMes)}</span>
              <span className="cp2-card-nota">
                {resumo.nPagoMes} {resumo.nPagoMes === 1 ? 'conta paga' : 'contas pagas'}{resumo.pagoHoje > 0 ? ` · ${brl(resumo.pagoHoje)} hoje` : ''}
              </span>
            </button>
          </div>

          {semNada ? (
            <div className="card cpr-vazio">
              <div className="cpr-vazio-icone">🗓️</div>
              <h3>Nenhuma conta ainda</h3>
              <p>Cadastre o que você tem pra pagar (luz, aluguel, fornecedor) e pra receber. Compra lançada em “Lançar compra” também aparece aqui.</p>
            </div>
          ) : (
            <>
              {/* abas */}
              <div className="cp2-abas" role="tablist">
                {[['pagar', 'A pagar', resumo.nPagar], ['receber', 'A receber', resumo.nReceber + fiado.clientes], ['pago', 'Já pago', null]].map(([id, lb, n]) => (
                  <button key={id} type="button" role="tab" aria-selected={aba === id} className={`cp2-aba ${aba === id ? 'ativa' : ''}`} onClick={() => setAba(id)}>
                    {lb}{n ? <span className="cp2-aba-n">{n}</span> : null}
                  </button>
                ))}
              </div>

              {/* A PAGAR / A RECEBER */}
              {aba !== 'pago' && (
                <>
                  {blocos.length === 0 && !(aba === 'receber' && fiado.total > 0) ? (
                    <div className="card cpr-vazio cpr-vazio-pequeno">
                      <div className="cpr-vazio-icone">{aba === 'pagar' ? '🎉' : '📭'}</div>
                      <p>{aba === 'pagar' ? 'Nada pra pagar. Tudo em dia!' : 'Nada pra receber no momento.'}</p>
                    </div>
                  ) : blocos.map((b) => (
                    <section key={b.id} className="cp2-bloco">
                      <header className="cp2-bloco-topo">
                        <h3><i className="cp2-ponto" style={{ background: b.cor }} />{b.rotulo}<span className="cp2-bloco-n">{b.itens.length}</span></h3>
                        <strong style={{ color: b.id === 'atrasadas' ? '#dc2626' : undefined }}>{brl(b.total)}</strong>
                      </header>
                      <ul className="cp2-lista">{b.itens.map(linha)}</ul>
                    </section>
                  ))}
                  {aba === 'receber' && fiado.total > 0 && (
                    <section className="cp2-bloco">
                      <header className="cp2-bloco-topo">
                        <h3><i className="cp2-ponto" style={{ background: '#d97706' }} />Fiado de clientes<span className="cp2-bloco-n">{fiado.clientes}</span></h3>
                        <strong>{brl(fiado.total)}</strong>
                      </header>
                      <ul className="cp2-lista">
                        {fiado.lista.map((f) => (
                          <li key={f.id} className="cp2-linha cp2-linha-fiado">
                            <span className="cp2-bolha" style={{ background: '#d977061f' }} aria-hidden="true">🧾</span>
                            <div className="cp2-info"><div className="cp2-nome"><strong>{f.nome}</strong></div><div className="cp2-detalhe"><span>vendeu fiado</span></div></div>
                            <div className="cp2-valor"><strong className="cpr-pos">{brl(f.saldo)}</strong></div>
                            {onAbrirFiado ? <button type="button" className="btn btn-secondary btn-sm" onClick={onAbrirFiado}>Receber no Fiado</button> : <span />}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {aba === 'receber' && resumo.recebidoMes > 0 && (
                    <p className="cp2-nota-rodape">Já recebido este mês: <strong>{brl(resumo.recebidoMes)}</strong></p>
                  )}
                </>
              )}

              {/* JÁ PAGO: pra onde foi o dinheiro */}
              {aba === 'pago' && (
                <>
                  <div className="cp2-periodo">
                    {[['mes', 'Este mês'], ['mes_passado', 'Mês passado'], ['tudo', 'Tudo']].map(([id, lb]) => (
                      <button key={id} type="button" className={`cp2-chip ${periodo === id ? 'ativo' : ''}`} onClick={() => { setPeriodo(id); setCatAberta(null) }}>{lb}</button>
                    ))}
                    <span className="cp2-periodo-total">Total <strong>{brl(pago.total)}</strong></span>
                  </div>

                  {pago.familias.length === 0 ? (
                    <div className="card cpr-vazio cpr-vazio-pequeno">
                      <div className="cpr-vazio-icone">🧾</div>
                      <p>Nenhuma conta paga nesse período.</p>
                    </div>
                  ) : (
                    <div className="cp2-familias">
                      {pago.familias.map((f) => {
                        const pct = pago.total > 0 ? (f.valor / pago.total) * 100 : 0
                        return (
                          <section key={f.id} className="cp2-familia" style={{ '--fam': f.cor }}>
                            <header className="cp2-familia-topo">
                              <span className="cp2-bolha-grande">{f.emoji}</span>
                              <div className="cp2-familia-nome">
                                <strong>{f.rotulo}</strong>
                                <span>{f.dica}</span>
                              </div>
                              <div className="cp2-familia-valor">
                                <strong>{brl(f.valor)}</strong>
                                <span>{pct.toFixed(0)}% do total</span>
                              </div>
                            </header>
                            <div className="cp2-barra"><i style={{ width: `${Math.max(2, pct)}%` }} /></div>
                            <ul className="cp2-cats">
                              {f.cats.map((g) => {
                                const aberta = catAberta === g.categoria
                                const p2 = f.valor > 0 ? (g.valor / f.valor) * 100 : 0
                                return (
                                  <li key={g.categoria}>
                                    <button type="button" className={`cp2-cat ${aberta ? 'aberta' : ''}`} onClick={() => setCatAberta(aberta ? null : g.categoria)} aria-expanded={aberta}>
                                      <span className="cp2-cat-seta">{aberta ? '▾' : '▸'}</span>
                                      <span className="cp2-cat-nome">{g.categoria}</span>
                                      <span className="cp2-cat-mini"><i style={{ width: `${Math.max(3, p2)}%` }} /></span>
                                      <span className="cp2-cat-valor">{brl(g.valor)}</span>
                                    </button>
                                    {aberta && <ul className="cp2-lista cp2-lista-dentro">{g.contas.map(linha)}</ul>}
                                  </li>
                                )
                              })}
                            </ul>
                          </section>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          <p className="cp2-rodape">
            ℹ️ Aqui é o <strong>dinheiro que sai e entra</strong> (caixa). O <strong>lucro do dia</strong> não muda por conta paga aqui:
            o custo da mercadoria já entra nele quando ela é vendida.
            {onTelaAntiga && <> · <button type="button" className="cp2-link" onClick={onTelaAntiga}>ver a tela antiga</button></>}
          </p>
        </>
      )}

      {form && (
        <FormConta form={form} setForm={setForm} sugestoes={sugestoes} clientes={clientes} hoje={hoje}
          onFechar={() => setForm(null)}
          onSalvo={(texto) => { setForm(null); avisar('ok', texto); carregar() }}
          onErro={(e, oQue) => avisar('erro', recadoDeErro(e, oQue))}
          empresaId={empresaId} />
      )}
      {baixaDe && (
        <ModalBaixa conta={baixaDe} hoje={hoje} onFechar={() => setBaixaDe(null)}
          onSalvo={(texto) => { setBaixaDe(null); avisar('ok', texto); carregar() }}
          onErro={(e) => avisar('erro', recadoDeErro(e, 'registrar o pagamento'))} />
      )}
      {historicoDe && (
        <ModalHistorico conta={historicoDe} onFechar={() => setHistoricoDe(null)}
          onMudou={() => { carregar() }} avisar={avisar} confirmar={confirmar} />
      )}
    </div>
  )
}

// Uma conta: ícone da família, nome, fornecedor + quando, a categoria, o valor e o botão.
function Linha({ c, hoje, menuAberto, onMenu, onBaixa, onEditar, onDuplicar, onHistorico, onExcluir }) {
  const [detalhe, setDetalhe] = useState(false)
  const sit = situacaoDe(c, hoje)
  const pagar = c.tipo === 'pagar'
  const rateio = Array.isArray(c.rateio) ? c.rateio.filter((r) => Number(r?.valor) > 0) : []
  const cat = rateio[0]?.categoria || c.categoria
  const fam = pagar ? familiaDe(cat || 'Sem categoria') : null
  const valor = sit === 'paga' ? Number(c.valor) : restanteDe(c)
  const parcial = c.status === 'aberta' && Number(c.valor_pago) > 0
  return (
    <li className={`cp2-linha cp2-sit-${sit}`}>
      <span className="cp2-bolha" style={fam ? { background: `${fam.cor}1f` } : undefined} aria-hidden="true">{fam ? fam.emoji : '💰'}</span>
      <div className="cp2-info">
        <div className="cp2-nome">
          <strong>{c.descricao}</strong>
          {c.parcelas > 1 && <span className="cp2-tag">{c.parcela}/{c.parcelas}</span>}
          {c.recorrencia !== 'nenhuma' && <span className="cp2-tag" title="Se repete">↻</span>}
        </div>
        <div className="cp2-detalhe">
          {c.pessoa && <span>{c.pessoa} · </span>}
          <span className={`cp2-quando cp2-quando-${sit}`}>{quandoTexto(c, hoje)}</span>
          {cat && (
            rateio.length > 1
              ? <button type="button" className="cp2-cat-chip cp2-cat-chip-btn" onClick={() => setDetalhe((d) => !d)}>{cat} +{rateio.length - 1} {detalhe ? '▴' : '▾'}</button>
              : <span className="cp2-cat-chip">{cat}</span>
          )}
        </div>
        {detalhe && rateio.length > 1 && (
          <div className="cp2-rateio">
            {rateio.map((r) => <span key={r.categoria}>{r.categoria} <strong>{brl(Number(r.valor))}</strong></span>)}
          </div>
        )}
      </div>
      <div className="cp2-valor">
        <strong className={pagar ? 'cpr-neg' : 'cpr-pos'}>{brl(valor)}</strong>
        {parcial && <span>pago {brl(c.valor_pago)} de {brl(c.valor)}</span>}
      </div>
      <div className="cp2-botoes">
        {c.status === 'aberta' && (
          <button type="button" className={`btn btn-sm ${pagar ? 'cpr-btn-pagar' : 'cpr-btn-receber'}`} onClick={onBaixa}>{pagar ? 'Pagar' : 'Receber'}</button>
        )}
        <div className="cpr-menu-wrap">
          <button type="button" className="btn btn-secondary btn-sm cpr-menu-btn" aria-haspopup="menu" aria-expanded={menuAberto} aria-label={`Mais ações para ${c.descricao}`} onClick={onMenu}>⋯</button>
          {menuAberto && (
            <div className="cpr-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <button type="button" role="menuitem" onClick={onEditar}>✏️ Editar</button>
              <button type="button" role="menuitem" onClick={onDuplicar}>📄 Duplicar (mês seguinte)</button>
              <button type="button" role="menuitem" onClick={onHistorico}>🧾 {pagar ? 'Pagamentos' : 'Recebimentos'}</button>
              <button type="button" role="menuitem" className="cpr-menu-perigo" onClick={onExcluir}>🗑️ Excluir</button>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
