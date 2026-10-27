import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { recadoDeErro } from '../lib/erroRede'
import { CATEGORIAS_INSUMO } from '../lib/categoriasFinanceiro'
import { useCategoriasInsumo } from '../hooks/useCategoriasInsumo'
import '../components/Page.css'

// COZINHA — o que sai do estoque (almoxarifado) pra cozinha e o que volta no fim do dia.
//
// Pedido do AGV Grill (27/10/2026): o dono entrega o insumo ("10 kg de frango, 2 de tomate…") e no fim do dia
// o cozinheiro traz os pesos do que sobrou. Ele faz tudo sozinho e pelo celular, então a tela é de dedo:
// escolhe quem pediu, toca nos itens, digita as quantidades, entrega. No fim do dia, digita o que voltou.
//
//   entrega = SAÍDA de matéria-prima (no custo do momento) · sobra = ENTRADA de volta · usado = entregue − voltou
//
// As contas ficam no banco (mig 0409: requisitar_insumos / registrar_sobra / desfazer_requisicao); aqui só se
// pergunta e se mostra. O saldo, o "valor parado" e o histórico de estoque continuam batendo sozinhos.

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const qtdTxt = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 })
const num = (s) => { const n = Number(String(s ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0 }
const r2 = (n) => Math.round(n * 100) / 100
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const somaDias = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d) }
const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
const diaTxt = (s) => new Date(`${s}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const cartao = { background: 'var(--bg-card, var(--card, #fff))', border: '1px solid var(--border)', borderRadius: 14 }
const campo = { padding: '11px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 16, minWidth: 0 }
const pilula = (on) => ({ padding: '9px 14px', borderRadius: 999, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 14, fontWeight: 700,
  background: on ? 'var(--primary)' : 'transparent', color: on ? '#fff' : 'var(--text)' })

export default function CozinhaRequisicao({ empresaId }) {
  const { icone } = useCategoriasInsumo(empresaId)
  const hoje = ymd(new Date())
  const [funcs, setFuncs] = useState([])
  const [materias, setMaterias] = useState([])
  const [reqs, setReqs] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [periodo, setPeriodo] = useState('hoje')
  const [estimado, setEstimado] = useState(null)   // { custo, vendido } estimados pelas vendas do período

  const [funcId, setFuncId] = useState('')
  const [linhas, setLinhas] = useState([])
  const [busca, setBusca] = useState('')
  const [obs, setObs] = useState('')
  const [catSel, setCatSel] = useState(null)       // categoria aberta nos cartões (igual ao "+ Vender")
  const [salvando, setSalvando] = useState(false)
  const [ultima, setUltima] = useState(null)       // última entrega do cozinheiro escolhido (pra repetir)

  const [aberta, setAberta] = useState(null)       // entrega expandida
  const [sobra, setSobra] = useState(null)         // { id, valores: { itemId: texto } }

  const [de, ate] = useMemo(() => {
    if (periodo === 'ontem') return [somaDias(hoje, -1), somaDias(hoje, -1)]
    if (periodo === '7d') return [somaDias(hoje, -6), hoje]
    return [hoje, hoje]
  }, [periodo, hoje])

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setCarregando(true)
    setErro(null)
    try {
      // O que a conta da loja ESPERA ter gasto: custo estimado dos pratos vendidos (ficha técnica ou % do vendido).
      // É o mesmo número do "Dia a dia" — a comparação com o gasto real da cozinha nasce daqui.
      const noInstante = (dia) => new Date(`${dia}T00:00:00-03:00`).toISOString()
      const [f, pf, m, r, ce] = await Promise.all([
        supabase.from('funcionarios').select('id, nome, cargo').eq('empresa_id', empresaId).eq('ativo', true).order('nome'),
        // A equipe com LOGIN (tela Funcionários) também pede insumo — a loja pode ter cadastrado só ali (mig 0413).
        supabase.from('profiles').select('id, nome, email, perfil, cargo, ativo').eq('empresa_id', empresaId),
        fetchAll(() => supabase.from('materia_prima_saldo').select('materia_prima_id, nome, unidade, custo, quantidade_atual, categoria').order('materia_prima_id')),
        supabase.from('requisicoes_cozinha').select('*, requisicao_itens(*)').eq('empresa_id', empresaId)
          .gte('data', de).lte('data', ate).order('created_at', { ascending: false }),
        supabase.rpc('custo_vendido_periodo', { p_ini: noInstante(de), p_fim: noInstante(somaDias(ate, 1)), p_empresa_id: empresaId }),
      ])
      if (ce.error) setEstimado(null)
      else setEstimado({
        custo: r2((ce.data || []).reduce((s, x) => s + Number(x.custo || 0), 0)),
        vendido: r2((ce.data || []).reduce((s, x) => s + Number(x.valor_vendido || 0), 0)),
      })
      if (f.error) throw f.error
      if (m.error) throw m.error
      if (r.error) throw r.error
      // As duas listas numa só, sem repetir o mesmo nome. Dono (admin) e entregador não pedem insumo.
      // "Mesma pessoa" quando todas as palavras do nome mais curto estão no mais comprido — o login
      // "Waleska" é a "Germânia Waleska Silva Matias" da folha, e "Raurison Lima  da SIlva" (dois
      // espaços) é o "Raurison Lima da Silva" do login (AGV, 27/10).
      const palavras = (s) => norm(s).split(/\s+/).filter(w => w.length > 2 && !['das', 'dos'].includes(w))
      const mesma = (a, b) => {
        const [pa, pb] = [palavras(a), palavras(b)].sort((x, y) => x.length - y.length)
        return pa.length > 0 && pa.every(w => pb.includes(w))
      }
      const pessoas = (f.data || []).map(x => ({ id: `f:${x.id}`, nome: x.nome.replace(/\s+/g, ' ').trim(), cargo: x.cargo || '' }))
      for (const x of (pf.error ? [] : (pf.data || []))) {
        if (x.ativo === false || ['admin', 'super_admin', 'cliente', 'entregador'].includes(x.perfil)) continue
        const nome = ((x.nome || '').trim() || x.email).replace(/\s+/g, ' ')
        if (!nome || pessoas.some(p => mesma(p.nome, nome))) continue
        pessoas.push({ id: `p:${x.id}`, nome, cargo: x.cargo || x.perfil || '' })
      }
      setFuncs(pessoas)
      setMaterias((m.data || []).map(x => ({ id: x.materia_prima_id, nome: x.nome, unidade: x.unidade, custo: Number(x.custo || 0), saldo: Number(x.quantidade_atual || 0), categoria: x.categoria })))
      setReqs(r.data || [])
    } catch (e) {
      setErro(recadoDeErro(e, 'carregar a cozinha'))
    } finally {
      setCarregando(false)
    }
  }, [empresaId, de, ate])

  useEffect(() => { carregar() }, [carregar])

  // Cozinheiros primeiro na fila de "quem pediu": é quem pede insumo todo dia.
  // Só o pessoal da cozinha aparece de cara; garçom, segurança e gerente ficam em "+ outros".
  // "zinh" pega também o cargo escrito "Conzinheiro" (AGV).
  const [verTodos, setVerTodos] = useState(false)
  const ehCozinha = (f) => /zinh|churrasq|chef|auxiliar|cozinheiro/i.test(f.cargo || '')
  const funcsOrdenados = useMemo(() => {
    const ordem = [...funcs].sort((a, b) => (ehCozinha(b) ? 1 : 0) - (ehCozinha(a) ? 1 : 0) || a.nome.localeCompare(b.nome))
    const daCozinha = ordem.filter(ehCozinha)
    return verTodos || daCozinha.length === 0 ? ordem : ordem.filter(f => ehCozinha(f) || f.id === funcId)
  }, [funcs, verTodos, funcId])
  const outros = funcs.filter(f => !ehCozinha(f)).length

  // Última entrega do cozinheiro escolhido — pra repetir o pedido de sempre com um toque.
  useEffect(() => {
    setUltima(null)
    if (!funcId) return
    let vivo = true
    supabase.from('requisicoes_cozinha').select('data, requisicao_itens(materia_prima_id, quantidade)')
      .eq(funcId.startsWith('f:') ? 'funcionario_id' : 'profile_id', funcId.slice(2)).order('created_at', { ascending: false }).limit(1)
      .then(({ data }) => { if (vivo) setUltima(data?.[0] || null) })
    return () => { vivo = false }
  }, [funcId, reqs.length])

  const porId = useMemo(() => new Map(materias.map(m => [m.id, m])), [materias])
  const noCarrinho = useMemo(() => new Set(linhas.map(l => l.id)), [linhas])

  const sugestoes = useMemo(() => {
    const q = norm(busca).trim()
    if (!q) return []
    const palavras = (m) => norm(m.nome).split(/[^a-z0-9]+/)
    return materias.filter(m => !noCarrinho.has(m.id) && norm(m.nome).includes(q))
      .sort((a, b) => {
        const pa = norm(a.nome).startsWith(q) ? 0 : palavras(a).some(w => w.startsWith(q)) ? 1 : 2
        const pb = norm(b.nome).startsWith(q) ? 0 : palavras(b).some(w => w.startsWith(q)) ? 1 : 2
        return pa - pb || a.nome.localeCompare(b.nome)
      }).slice(0, 8)
  }, [busca, materias, noCarrinho])

  // Cartões por categoria (pra quem prefere tocar em vez de digitar), na mesma ordem do estoque.
  const porCategoria = useMemo(() => {
    const mapa = new Map()
    for (const m of materias) {
      const c = m.categoria || 'Sem categoria'
      if (!mapa.has(c)) mapa.set(c, [])
      mapa.get(c).push(m)
    }
    const ordem = [...CATEGORIAS_INSUMO, 'Sem categoria']
    return [...mapa.entries()]
      .map(([cat, itens]) => ({ cat, itens: itens.sort((a, b) => a.nome.localeCompare(b.nome)) }))
      .sort((a, b) => (ordem.indexOf(a.cat) + 1 || 99) - (ordem.indexOf(b.cat) + 1 || 99))
  }, [materias])

  const poe = (m, qtd = '') => { setLinhas(ls => ls.some(l => l.id === m.id) ? ls : [...ls, { id: m.id, qtd }]); setBusca('') }
  const repetir = () => {
    const itens = (ultima?.requisicao_itens || []).filter(i => porId.has(i.materia_prima_id))
    setLinhas(itens.map(i => ({ id: i.materia_prima_id, qtd: String(Number(i.quantidade)).replace('.', ',') })))
  }

  const totalCarrinho = r2(linhas.reduce((s, l) => s + num(l.qtd) * (porId.get(l.id)?.custo || 0), 0))
  const prontas = linhas.filter(l => num(l.qtd) > 0)
  const quem = funcs.find(f => f.id === funcId)

  async function entregar() {
    setErro(null)
    if (!funcId) { setErro('Escolha quem pediu.'); return }
    if (!prontas.length) { setErro('Coloque a quantidade de pelo menos um item.'); return }
    const falta = prontas.filter(l => num(l.qtd) > (porId.get(l.id)?.saldo ?? 0))
    if (falta.length && !window.confirm(`Atenção: o estoque não cobre ${falta.map(l => porId.get(l.id).nome).join(', ')}.\n\nEntregar mesmo assim (o saldo fica negativo)?`)) return
    setSalvando(true)
    try {
      const { error } = await supabase.rpc('requisitar_insumos', {
        p: { [funcId.startsWith('f:') ? 'funcionario_id' : 'profile_id']: funcId.slice(2), observacao: obs, itens: prontas.map(l => ({ id: l.id, quantidade: num(l.qtd) })) },
      })
      if (error) throw error
      setLinhas([]); setObs(''); setBusca('')
      await carregar()
    } catch (e) {
      setErro(recadoDeErro(e, 'entregar à cozinha'))
    } finally {
      setSalvando(false)
    }
  }

  async function desfazer(r) {
    if (!window.confirm(`Desfazer a entrega de ${r.funcionario_nome} (${brl(r.valor_total)})?\n\nO que saiu volta pro estoque.`)) return
    const { error } = await supabase.rpc('desfazer_requisicao', { p_id: r.id })
    if (error) { setErro(recadoDeErro(error, 'desfazer')); return }
    carregar()
  }

  function abrirSobra(r) {
    const valores = {}
    for (const i of r.requisicao_itens) valores[i.id] = r.status === 'fechada' ? String(Number(i.voltou)).replace('.', ',') : ''
    setSobra({ id: r.id, valores })
    setAberta(r.id)
  }
  async function salvarSobra(r) {
    setErro(null)
    const itens = r.requisicao_itens.map(i => ({ id: i.id, voltou: num(sobra.valores[i.id]) }))
    const ruim = r.requisicao_itens.find(i => num(sobra.valores[i.id]) > Number(i.quantidade))
    if (ruim) { setErro(`"${ruim.nome}": voltou mais do que foi entregue (${qtdTxt(ruim.quantidade)} ${ruim.unidade}).`); return }
    setSalvando(true)
    try {
      const { error } = await supabase.rpc('registrar_sobra', { p_id: r.id, p: { itens } })
      if (error) throw error
      setSobra(null)
      await carregar()
    } catch (e) {
      setErro(recadoDeErro(e, 'registrar a sobra'))
    } finally {
      setSalvando(false)
    }
  }

  // Resumo do período: quanto saiu, quanto voltou, quanto foi usado de verdade.
  const resumo = useMemo(() => {
    let entregue = 0, usado = 0, semSobra = 0
    for (const r of reqs) {
      entregue += Number(r.valor_total || 0)
      if (r.status === 'fechada') usado += Number(r.valor_usado || 0)
      else semSobra += Number(r.valor_total || 0)
    }
    return { entregue: r2(entregue), usado: r2(usado), semSobra: r2(semSobra), voltou: r2(entregue - semSobra - usado) }
  }, [reqs])

  return (
    <div style={{ maxWidth: 760 }}>
      {erro && <div className="alert alert-error" style={{ marginBottom: 12 }}>{erro}</div>}

      {/* ── Resumo ── */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {[['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', '7 dias']].map(([id, lb]) => (
          <button key={id} type="button" style={pilula(periodo === id)} onClick={() => setPeriodo(id)}>{lb}</button>
        ))}
      </div>
      <div style={{ ...cartao, padding: 14, marginBottom: 14, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, textAlign: 'center' }}>
        <div><div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>ENTREGUE</div><strong style={{ fontSize: 18 }}>{brl(resumo.entregue)}</strong></div>
        <div><div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>VOLTOU</div><strong style={{ fontSize: 18, color: 'var(--success, #16a34a)' }}>{brl(resumo.voltou)}</strong></div>
        <div><div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>USADO</div><strong style={{ fontSize: 18, color: 'var(--primary)' }}>{brl(resumo.usado)}</strong></div>
        {resumo.semSobra > 0 && (
          <div style={{ gridColumn: '1 / -1', fontSize: 13, fontWeight: 600, color: '#b45309', background: 'rgba(245,158,11,.12)', borderRadius: 8, padding: '6px 10px' }}>
            ⏳ {brl(resumo.semSobra)} ainda sem a sobra registrada — toque na entrega e digite o que voltou.
          </div>
        )}
      </div>

      {/* ── Real × estimado: a pergunta que o dono quer responder ── */}
      {estimado && resumo.usado > 0 && (() => {
        const dif = r2(resumo.usado - estimado.custo)
        const acima = dif > 0
        const pct = estimado.vendido > 0 ? Math.round((resumo.usado / estimado.vendido) * 100) : null
        return (
          <div style={{ ...cartao, padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 8 }}>⚖️ GASTO REAL × O QUE AS VENDAS PREVIAM</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 15 }}>
              <span>Gasto real da cozinha</span><b>{brl(resumo.usado)}</b>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 15, marginTop: 4 }}>
              <span>Previsto pelas vendas</span><b>{brl(estimado.custo)}</b>
            </div>
            <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, fontWeight: 700, fontSize: 14,
              background: acima ? 'rgba(220,38,38,.1)' : 'rgba(22,163,74,.1)', color: acima ? 'var(--danger, #dc2626)' : 'var(--success, #16a34a)' }}>
              {estimado.custo <= 0 ? 'Sem venda de prato com custo cadastrado nesse período — não há o que comparar ainda.'
                : Math.abs(dif) < 0.01 ? 'Bateu certinho.'
                : acima ? `Gastou ${brl(dif)} a MAIS do que as vendas previam.` : `Gastou ${brl(-dif)} a MENOS do que as vendas previam.`}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>
              {pct != null && estimado.vendido > 0 ? `Real = ${pct}% do vendido em pratos (${brl(estimado.vendido)}). ` : ''}
              {resumo.semSobra > 0 ? `Falta a sobra de ${brl(resumo.semSobra)} entregues — o gasto real ainda está incompleto. ` : ''}
              Se passa sempre pro mesmo lado, o percentual de custo dos pratos precisa ser ajustado (ou tem desperdício).
            </div>
          </div>
        )
      })()}

      {/* ── Nova entrega ── */}
      {periodo === 'hoje' && (
        <div style={{ ...cartao, padding: 14, marginBottom: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 16 }}>🍳 Nova entrega à cozinha</h3>

          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>QUEM PEDIU?</div>
          {funcs.length === 0 && !carregando && (
            <div style={{ fontSize: 14, color: 'var(--text-muted)' }}>Ninguém da equipe cadastrado. Cadastre em <b>Funcionários</b> e volte aqui.</div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {funcsOrdenados.map(f => (
              <button key={f.id} type="button" style={pilula(funcId === f.id)} onClick={() => setFuncId(f.id === funcId ? '' : f.id)}>
                {f.nome.split(' ').slice(0, 2).join(' ')}
              </button>
            ))}
            {outros > 0 && funcs.length > outros && (
              <button type="button" style={{ ...pilula(false), borderStyle: 'dashed', color: 'var(--text-muted)' }} onClick={() => setVerTodos(v => !v)}>
                {verTodos ? 'só a cozinha' : `+ outros (${outros})`}
              </button>
            )}
          </div>

          {funcId && ultima?.requisicao_itens?.length > 0 && linhas.length === 0 && (
            <button type="button" className="btn btn-secondary btn-sm" style={{ marginBottom: 12 }} onClick={repetir}>
              ↻ Repetir a última de {quem?.nome.split(' ')[0]} ({diaTxt(ultima.data)})
            </button>
          )}

          <div style={{ position: 'relative' }}>
            <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="🔎 Procurar insumo (frango, tomate…)"
              style={{ ...campo, width: '100%', boxSizing: 'border-box' }} />
            {sugestoes.length > 0 && (
              <div style={{ ...cartao, marginTop: 4, overflow: 'hidden' }}>
                {sugestoes.map(m => (
                  <button key={m.id} type="button" onClick={() => poe(m)}
                    style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: 8, padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', fontSize: 15 }}>
                    <span>{icone(m.categoria)} <b>{m.nome}</b></span>
                    <span style={{ color: m.saldo <= 0 ? 'var(--danger, #dc2626)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>tem {qtdTxt(m.saldo)} {m.unidade}</span>
                  </button>
                ))}
              </div>
            )}
            {busca.trim() && sugestoes.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>Não achei "{busca}" no estoque de insumos (ou já está na entrega).</div>
            )}
          </div>

          {/* Ou vai tocando: categoria → itens (igual ao "+ Vender") */}
          {!busca.trim() && porCategoria.length > 0 && (() => {
            const grade = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginTop: 10 }
            const tile = { textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', minHeight: 56 }
            if (!catSel) return (
              <div style={grade}>
                {porCategoria.map(g => (
                  <button key={g.cat} type="button" style={tile} onClick={() => setCatSel(g.cat)}>
                    <b style={{ display: 'block', fontSize: 14 }}>{icone(g.cat)} {g.cat}</b>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{g.itens.length} {g.itens.length === 1 ? 'item' : 'itens'}</span>
                  </button>
                ))}
              </div>
            )
            const g = porCategoria.find(x => x.cat === catSel)
            return (
              <div style={{ marginTop: 10 }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCatSel(null)}>← Categorias</button>
                <b style={{ marginLeft: 8 }}>{icone(catSel)} {catSel}</b>
                <div style={grade}>
                  {(g?.itens || []).map(m => {
                    const ja = noCarrinho.has(m.id)
                    return (
                      <button key={m.id} type="button" disabled={ja} onClick={() => poe(m)}
                        style={{ ...tile, opacity: ja ? .5 : 1, borderColor: ja ? 'var(--primary)' : 'var(--border)' }}>
                        <b style={{ display: 'block', fontSize: 14 }}>{ja ? '✓ ' : ''}{m.nome}</b>
                        <span style={{ fontSize: 12, color: m.saldo <= 0 ? 'var(--danger, #dc2626)' : 'var(--text-muted)' }}>tem {qtdTxt(m.saldo)} {m.unidade}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {linhas.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {linhas.map(l => {
                const m = porId.get(l.id)
                if (!m) return null
                const q = num(l.qtd)
                const falta = q > m.saldo
                return (
                  <div key={l.id} style={{ border: `1px solid ${falta ? 'var(--danger, #dc2626)' : 'var(--border)'}`, borderRadius: 10, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                      <b style={{ overflowWrap: 'anywhere' }}>{m.nome}</b>
                      <button type="button" onClick={() => setLinhas(ls => ls.filter(x => x.id !== l.id))} aria-label={`Tirar ${m.nome}`}
                        style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      <input inputMode="decimal" value={l.qtd} placeholder="0"
                        onChange={e => setLinhas(ls => ls.map(x => x.id === l.id ? { ...x, qtd: e.target.value } : x))}
                        style={{ ...campo, width: 100, textAlign: 'right' }} />
                      <span style={{ fontWeight: 700 }}>{m.unidade}</span>
                      <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{q > 0 && m.custo > 0 ? brl(q * m.custo) : ''}</span>
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 4, color: falta ? 'var(--danger, #dc2626)' : 'var(--text-muted)', fontWeight: falta ? 700 : 400 }}>
                      {falta ? `⚠️ só tem ${qtdTxt(m.saldo)} ${m.unidade} no estoque` : `estoque: ${qtdTxt(m.saldo)} ${m.unidade}`}
                      {m.custo > 0 ? ` · ${brl(m.custo)}/${m.unidade}` : ' · sem custo cadastrado'}
                    </div>
                  </div>
                )
              })}
              <input value={obs} onChange={e => setObs(e.target.value)} placeholder="Observação (opcional)" style={{ ...campo, width: '100%', boxSizing: 'border-box' }} />
              <button type="button" className="btn btn-primary" disabled={salvando} onClick={entregar} style={{ padding: '14px', fontSize: 16, fontWeight: 800 }}>
                {salvando ? 'Entregando…' : `Entregar à cozinha${quem ? ` — ${quem.nome.split(' ')[0]}` : ''}${totalCarrinho > 0 ? ` · ${brl(totalCarrinho)}` : ''}`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Entregas do período ── */}
      {carregando ? <div style={{ ...cartao, padding: 14 }}>Carregando…</div> : reqs.length === 0 ? (
        <div style={{ ...cartao, padding: 18, textAlign: 'center', color: 'var(--text-muted)' }}>
          Nenhuma entrega {periodo === 'hoje' ? 'hoje' : periodo === 'ontem' ? 'ontem' : 'nesses dias'}.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {reqs.map(r => {
            const itens = [...(r.requisicao_itens || [])].sort((a, b) => a.nome.localeCompare(b.nome))
            const isAberta = aberta === r.id
            const editando = sobra?.id === r.id
            const fechada = r.status === 'fechada'
            return (
              <div key={r.id} style={{ ...cartao, overflow: 'hidden' }}>
                <button type="button" aria-expanded={isAberta} onClick={() => setAberta(isAberta ? null : r.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: 14, border: 'none', background: 'transparent', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
                  <span style={{ fontSize: 24 }}>{fechada ? '✅' : '⏳'}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ display: 'block', fontSize: 15 }}>{r.funcionario_nome}</b>
                    <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      {periodo === 'hoje' ? '' : `${diaTxt(r.data)} · `}{hora(r.created_at)} · {itens.length} {itens.length === 1 ? 'item' : 'itens'}
                      {fechada ? ' · sobra registrada' : ' · aguardando a sobra'}
                    </span>
                  </span>
                  <span style={{ textAlign: 'right' }}>
                    <b style={{ display: 'block', fontSize: 16 }}>{brl(fechada ? r.valor_usado : r.valor_total)}</b>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fechada ? `de ${brl(r.valor_total)}` : 'entregue'}</span>
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>{isAberta ? '▾' : '▸'}</span>
                </button>

                {isAberta && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '6px 14px 14px' }}>
                    {r.observacao && <div style={{ fontSize: 13, color: 'var(--text-muted)', margin: '8px 0' }}>📝 {r.observacao}</div>}
                    {itens.map(i => {
                      const usou = Number(i.quantidade) - (editando ? Math.min(num(sobra.valores[i.id]), Number(i.quantidade)) : Number(i.voltou))
                      return (
                        <div key={i.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <b style={{ overflowWrap: 'anywhere' }}>{i.nome}</b>
                            <span style={{ whiteSpace: 'nowrap' }}>{qtdTxt(i.quantidade)} {i.unidade}</span>
                          </div>
                          {editando ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Voltou</span>
                              <input inputMode="decimal" value={sobra.valores[i.id]} placeholder="0"
                                onChange={e => setSobra(s => ({ ...s, valores: { ...s.valores, [i.id]: e.target.value } }))}
                                style={{ ...campo, width: 90, textAlign: 'right' }} />
                              <span style={{ fontWeight: 700 }}>{i.unidade}</span>
                              <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-muted)' }}>usou {qtdTxt(usou)}</span>
                            </div>
                          ) : fechada ? (
                            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
                              voltou {qtdTxt(i.voltou)} · usou <b style={{ color: 'var(--text)' }}>{qtdTxt(usou)} {i.unidade}</b>{i.custo_unit ? ` · ${brl(usou * Number(i.custo_unit))}` : ''}
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                      {editando ? (
                        <>
                          <button type="button" className="btn btn-primary" disabled={salvando} onClick={() => salvarSobra(r)}>{salvando ? 'Salvando…' : 'Salvar sobra'}</button>
                          <button type="button" className="btn btn-secondary" onClick={() => setSobra(null)}>Cancelar</button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="btn btn-primary" onClick={() => abrirSobra(r)}>{fechada ? 'Corrigir a sobra' : '⚖️ Registrar o que sobrou'}</button>
                          <button type="button" className="btn btn-danger btn-sm" onClick={() => desfazer(r)}>Desfazer entrega</button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
