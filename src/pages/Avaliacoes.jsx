import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'
import './Avaliacoes.css'

// /avaliacoes — o que os clientes acharam, por loja (mig 0448).
//
// A nota é gravada em pedidos_delivery por dois caminhos: o cliente na página do
// pedido e o robô do WhatsApp (avaliacao_origem diz qual). Até aqui ela só
// aparecia dentro do card do pedido, no dia — passou o dia, sumiu de vista.
// Esta tela junta tudo: média, estrelas, o recado em destaque e, na nota baixa,
// um jeito de marcar "já falei com o cliente".

const PERIODOS = [
  { v: '7', label: 'Últimos 7 dias' },
  { v: '30', label: 'Últimos 30 dias' },
  { v: '60', label: 'Últimos 60 dias' },
  { v: '90', label: 'Últimos 90 dias' },
  { v: 'tudo', label: 'Desde o começo' },
]

const FILTROS_NOTA = [
  { v: 'todas', label: 'Todas as notas' },
  { v: 'baixas', label: 'Nota 3 ou menos' },
  { v: '5', label: '5 estrelas' },
  { v: '4', label: '4 estrelas' },
  { v: '3', label: '3 estrelas' },
  { v: '2', label: '2 estrelas' },
  { v: '1', label: '1 estrela' },
]

const ORIGEM = {
  pagina: { label: 'Página do pedido', icone: '🧾' },
  whatsapp: { label: 'WhatsApp', icone: '💬' },
}

function formatarTelefone(p) {
  const d = String(p || '').replace(/\D/g, '')
  const semPais = d.startsWith('55') && d.length > 11 ? d.slice(2) : d
  if (semPais.length >= 10) {
    const ddd = semPais.slice(0, 2)
    const resto = semPais.slice(2)
    const meio = resto.length >= 9 ? resto.slice(0, 5) : resto.slice(0, 4)
    const fim = resto.length >= 9 ? resto.slice(5) : resto.slice(4)
    return `(${ddd}) ${meio}-${fim}`
  }
  return p || ''
}

// Mesma chave da tela de Conversas: os 8 últimos dígitos juntam as duas formas
// do mesmo celular (com e sem o 9).
const chaveTel = p => String(p || '').replace(/\D/g, '').slice(-8)

function Estrelas({ nota, tamanho = 18 }) {
  return (
    <span className="av-estrelas" style={{ fontSize: tamanho }} aria-label={`${nota} de 5 estrelas`}>
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} className={i <= nota ? 'av-estrela cheia' : 'av-estrela'}>★</span>
      ))}
    </span>
  )
}

function quando(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export default function Avaliacoes() {
  const { profile, user } = useAuth()
  const empresaId = profile?.empresa_id ?? null

  const [periodo, setPeriodo] = useState('30')
  const [filtroNota, setFiltroNota] = useState('todas')
  const [soSemTratar, setSoSemTratar] = useState(false)

  const [avaliacoes, setAvaliacoes] = useState([])
  const [entregues, setEntregues] = useState(null)
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    if (!empresaId) return
    setLoading(true)
    setErro(null)
    const desde = periodo === 'tudo'
      ? null
      : new Date(Date.now() - Number(periodo) * 24 * 60 * 60 * 1000).toISOString()

    // Limite de 1000 linhas do Supabase: fetchAll pagina.
    const lista = fetchAll(() => {
      let q = supabase.from('pedidos_delivery')
        .select('id, numero_pedido, cliente_nome, cliente_telefone, avaliacao_nota, avaliacao_comentario, avaliacao_at, avaliacao_origem, avaliacao_tratada_at, created_at')
        .eq('empresa_id', empresaId)
        .not('avaliacao_nota', 'is', null)
        .order('avaliacao_at', { ascending: false, nullsFirst: false })
      if (desde) q = q.gte('avaliacao_at', desde)
      return q
    })

    // Pedidos entregues no mesmo período, pra taxa de resposta. iFood fica de
    // fora: o cliente dele não recebe o pedido de nota da loja.
    let qc = supabase.from('pedidos_delivery')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresaId).eq('status', 'entregue')
      .or('origem.is.null,origem.neq.ifood')
    if (desde) qc = qc.gte('created_at', desde)

    const [l, c] = await Promise.all([lista, qc])
    if (l.error) {
      setErro(l.error.message)
      setAvaliacoes([])
    } else {
      setAvaliacoes(l.data ?? [])
    }
    setEntregues(c.error ? null : (c.count ?? 0))
    setLoading(false)
  }, [empresaId, periodo])

  useEffect(() => { load() }, [load])

  const resumo = useMemo(() => {
    const total = avaliacoes.length
    const porNota = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    let soma = 0
    for (const a of avaliacoes) {
      porNota[a.avaliacao_nota] = (porNota[a.avaliacao_nota] ?? 0) + 1
      soma += a.avaliacao_nota
    }
    const baixas = avaliacoes.filter(a => a.avaliacao_nota <= 3)
    return {
      total,
      porNota,
      media: total ? soma / total : 0,
      baixas: baixas.length,
      baixasSemTratar: baixas.filter(a => !a.avaliacao_tratada_at).length,
      comRecado: avaliacoes.filter(a => (a.avaliacao_comentario ?? '').trim()).length,
    }
  }, [avaliacoes])

  const visiveis = useMemo(() => avaliacoes.filter(a => {
    if (filtroNota === 'baixas' && a.avaliacao_nota > 3) return false
    if (/^[1-5]$/.test(filtroNota) && a.avaliacao_nota !== Number(filtroNota)) return false
    if (soSemTratar && !(a.avaliacao_nota <= 3 && !a.avaliacao_tratada_at)) return false
    return true
  }), [avaliacoes, filtroNota, soSemTratar])

  async function marcarTratada(a, tratada) {
    setBusy(a.id)
    const { error } = await supabase.from('pedidos_delivery')
      .update(tratada
        ? { avaliacao_tratada_at: new Date().toISOString(), avaliacao_tratada_por: user?.id ?? null }
        : { avaliacao_tratada_at: null, avaliacao_tratada_por: null })
      .eq('id', a.id).eq('empresa_id', empresaId)
    // Só muda na tela depois que o banco confirma: marcar "já falei" e não
    // gravar faria a loja esquecer um cliente insatisfeito.
    if (error) {
      alert(`Não consegui salvar: ${error.message}`)
    } else {
      setAvaliacoes(prev => prev.map(x => x.id === a.id
        ? { ...x, avaliacao_tratada_at: tratada ? new Date().toISOString() : null }
        : x))
    }
    setBusy(null)
  }

  const maxBarra = Math.max(1, ...Object.values(resumo.porNota))
  const taxa = entregues && entregues > 0 ? (resumo.total / entregues) * 100 : null

  return (
    <div className="av-pagina">
      <div className="page-header">
        <h1>Avaliações</h1>
      </div>
      <p style={{ color: 'var(--text-muted)', marginTop: -6, maxWidth: 720 }}>
        A nota que o cliente deu depois de receber o pedido — pela página do pedido ou respondendo o
        WhatsApp. Nota 3 ou menos fica em destaque até alguém marcar <b>já falei com o cliente</b>.
      </p>

      <div className="toolbar">
        <select value={periodo} onChange={e => setPeriodo(e.target.value)} aria-label="Período">
          {PERIODOS.map(p => <option key={p.v} value={p.v}>{p.label}</option>)}
        </select>
        <select value={filtroNota} onChange={e => setFiltroNota(e.target.value)} aria-label="Filtrar por nota">
          {FILTROS_NOTA.map(p => <option key={p.v} value={p.v}>{p.label}</option>)}
        </select>
        <button
          className={`btn btn-sm ${soSemTratar ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setSoSemTratar(v => !v)}
        >
          {soSemTratar ? '● Notas baixas sem retorno' : 'Notas baixas sem retorno'}
        </button>
      </div>

      {erro && <div className="card" style={{ color: 'var(--danger)' }}>Não consegui carregar: {erro}</div>}

      {loading ? (
        <div className="card"><div className="skeleton-row" /><div className="skeleton-row" style={{ width: '70%' }} /></div>
      ) : (
        <>
          <div className="av-resumo">
            <div className="card av-media">
              <div className="av-media-num">{resumo.total ? resumo.media.toFixed(1).replace('.', ',') : '—'}</div>
              <Estrelas nota={Math.round(resumo.media)} tamanho={22} />
              <div className="av-media-sub">
                {resumo.total} avaliaç{resumo.total === 1 ? 'ão' : 'ões'}
                {resumo.comRecado > 0 && <> · {resumo.comRecado} com recado</>}
              </div>
              {taxa !== null && (
                <div className="av-media-sub" title="Só pedidos da loja; iFood não entra.">
                  {resumo.total} de {entregues} entregues avaliaram ({taxa.toFixed(1).replace('.', ',')}%)
                </div>
              )}
              {resumo.baixasSemTratar > 0 && (
                <div className="av-alerta">
                  {resumo.baixasSemTratar} nota{resumo.baixasSemTratar === 1 ? '' : 's'} baixa{resumo.baixasSemTratar === 1 ? '' : 's'} sem retorno
                </div>
              )}
            </div>

            <div className="card av-barras">
              {[5, 4, 3, 2, 1].map(n => (
                <div key={n} className="av-barra-linha">
                  <span className="av-barra-rotulo">{n} ★</span>
                  <div className="av-barra-trilho">
                    <div
                      className={`av-barra-cheia ${n <= 3 ? 'baixa' : ''}`}
                      style={{ width: `${(resumo.porNota[n] / maxBarra) * 100}%` }}
                    />
                  </div>
                  <span className="av-barra-qtd">{resumo.porNota[n]}</span>
                </div>
              ))}
            </div>
          </div>

          {entregues !== null && taxa !== null && taxa < 5 && (
            <p className="av-aviso">
              Pouca gente avalia: o robô pede a nota em todo pedido entregue, mas só uma fração responde.
              A média reflete quem respondeu, não todos os clientes.
            </p>
          )}

          {visiveis.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon" style={{ fontSize: 22 }}>⭐</div>
              <strong>{avaliacoes.length === 0 ? 'Nenhuma avaliação neste período' : 'Nada com esse filtro'}</strong>
              <p>
                {avaliacoes.length === 0
                  ? 'Quando um cliente avaliar o pedido, a nota aparece aqui.'
                  : 'Tente outra nota ou outro período.'}
              </p>
            </div>
          ) : (
            <div className="av-lista">
              {visiveis.map(a => {
                const baixa = a.avaliacao_nota <= 3
                const tratada = !!a.avaliacao_tratada_at
                const recado = (a.avaliacao_comentario ?? '').trim()
                const origem = ORIGEM[a.avaliacao_origem]
                const tel = chaveTel(a.cliente_telefone)
                return (
                  <article
                    key={a.id}
                    className={`card av-item ${baixa && !tratada ? 'atencao' : ''} ${baixa && tratada ? 'tratada' : ''}`}
                  >
                    <header className="av-item-topo">
                      <Estrelas nota={a.avaliacao_nota} />
                      <strong className="av-item-nota">{a.avaliacao_nota}/5</strong>
                      {baixa && !tratada && <span className="badge badge-danger">Atenção</span>}
                      {baixa && tratada && <span className="badge badge-success">Cliente atendido</span>}
                      <span className="av-item-quando">{quando(a.avaliacao_at ?? a.created_at)}</span>
                    </header>

                    {recado && <blockquote className="av-recado">“{recado}”</blockquote>}

                    <div className="av-item-meta">
                      <span><b>Pedido #{a.numero_pedido}</b></span>
                      <span>
                        {a.cliente_nome || 'Cliente sem nome'}
                        {a.cliente_telefone && <> · {formatarTelefone(a.cliente_telefone)}</>}
                      </span>
                      {origem && <span className="badge badge-neutral">{origem.icone} {origem.label}</span>}
                    </div>

                    <div className="av-item-acoes">
                      <Link
                        className="btn btn-secondary btn-sm"
                        to={`/pedidos-delivery?busca=${encodeURIComponent(a.numero_pedido)}&dia=${new Date(a.created_at).toLocaleDateString('sv-SE')}`}
                      >
                        Ver pedido
                      </Link>
                      {tel && (
                        <Link
                          className="btn btn-secondary btn-sm"
                          to={`/whatsapp-conversas?tel=${tel}`}
                        >
                          Abrir conversa
                        </Link>
                      )}
                      {baixa && (
                        <button
                          className={`btn btn-sm ${tratada ? 'btn-secondary' : 'btn-primary'}`}
                          disabled={busy === a.id}
                          onClick={() => marcarTratada(a, !tratada)}
                        >
                          {tratada ? 'Desfazer “já falei”' : 'Já falei com o cliente'}
                        </button>
                      )}
                      {baixa && tratada && (
                        <span className="av-tratada-em">marcado em {quando(a.avaliacao_tratada_at)}</span>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
