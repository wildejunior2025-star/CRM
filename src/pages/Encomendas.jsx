import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { hojeBR } from '../lib/feriados'
import CalendarioEncomenda from '../components/CalendarioEncomenda'
import '../components/Page.css'
import './Encomendas.css'

// /encomendas — agenda da loja que vende sob encomenda (mig 0452).
//
// A dona decide QUAIS dias aceita encomenda e QUANTAS cabem em cada um. O
// cliente só enxerga o que está liberado aqui: dia sem linha fica fechado, e
// dia que bateu o limite aparece lotado. A regra é conferida de novo no banco
// (encomenda_validar) — esta tela só grava os números.

const SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
const brl = (v) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`
const dataBR = (ymd) => String(ymd).split('-').reverse().join('/')

function somaDias(ymd, n) {
  const [a, m, d] = ymd.split('-').map(Number)
  const dt = new Date(a, m - 1, d + n)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}
const diaDaSemana = (ymd) => {
  const [a, m, d] = ymd.split('-').map(Number)
  return new Date(a, m - 1, d).getDay()
}

export default function Encomendas() {
  const { profile, empresa } = useAuth()
  const empresaId = profile?.empresa_id
  const hoje = hojeBR()

  const [cfg, setCfg] = useState({ antecedencia: 3, entrada: 50 })
  const [agenda, setAgenda] = useState({})        // ymd -> { liberado, limite, usados }
  const [pedidos, setPedidos] = useState([])
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState('')
  const [msg, setMsg] = useState('')
  const [salvando, setSalvando] = useState(false)

  const [diaSel, setDiaSel] = useState('')
  const [limiteDia, setLimiteDia] = useState('')

  // Liberar vários dias de uma vez
  const [lote, setLote] = useState({ de: '', ate: '', limite: '', dias: [0, 1, 2, 3, 4, 5, 6] })

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setErro('')
    const ate = somaDias(hoje, 400)
    const [emp, ag, ped] = await Promise.all([
      supabase.from('empresas').select('encomenda_antecedencia_dias, encomenda_entrada_pct').eq('id', empresaId).maybeSingle(),
      supabase.rpc('encomenda_agenda', { p_empresa: empresaId, p_de: hoje, p_ate: ate }),
      supabase.from('pedidos_delivery')
        .select('id, numero_pedido, cliente_nome, cliente_telefone, agendado_para, total, status, observacoes')
        .eq('empresa_id', empresaId).eq('encomenda', true).neq('status', 'cancelado')
        .gte('agendado_para', `${hoje}T00:00:00-03:00`)
        .order('agendado_para', { ascending: true }).limit(200),
    ])
    if (emp.error || ag.error || ped.error) {
      setErro((emp.error || ag.error || ped.error).message)
    }
    if (emp.data) {
      setCfg({
        antecedencia: Number(emp.data.encomenda_antecedencia_dias ?? 3),
        entrada: Number(emp.data.encomenda_entrada_pct ?? 50),
      })
    }
    setAgenda(Object.fromEntries((ag.data ?? []).map(r => [r.dia, r])))
    setPedidos(ped.data ?? [])
    setLoading(false)
  }, [empresaId, hoje])

  useEffect(() => { carregar() }, [carregar])

  const info = (ymd) => {
    if (ymd < hoje) return { estado: 'passado' }
    const r = agenda[ymd]
    if (!r || !r.liberado) return { estado: 'fechado' }
    const lim = Number(r.limite) || 0
    const usados = Number(r.usados) || 0
    if (lim > 0 && usados >= lim) return { estado: 'lotado', sub: `${usados}/${lim}` }
    return { estado: 'livre', sub: lim > 0 ? `${usados}/${lim}` : (usados ? `${usados}` : '') }
  }

  function escolherDia(ymd) {
    setMsg('')
    setDiaSel(ymd)
    const r = agenda[ymd]
    setLimiteDia(r ? String(r.limite ?? 0) : '')
  }

  async function gravarDia(ymd, liberado, limite) {
    setSalvando(true); setMsg(''); setErro('')
    const { error } = await supabase.from('encomenda_dias')
      .upsert({ empresa_id: empresaId, dia: ymd, liberado, limite: Math.max(0, Math.floor(Number(limite) || 0)) },
        { onConflict: 'empresa_id,dia' })
    setSalvando(false)
    if (error) { setErro(`Não consegui salvar: ${error.message}`); return false }
    await carregar()
    return true
  }

  async function liberarDia() {
    if (limiteDia === '' || Number.isNaN(Number(limiteDia))) {
      setErro('Diga quantas encomendas cabem nesse dia (0 = sem limite).')
      return
    }
    if (await gravarDia(diaSel, true, limiteDia)) setMsg(`Dia ${dataBR(diaSel)} liberado.`)
  }

  async function bloquearDia() {
    setSalvando(true); setMsg(''); setErro('')
    const { error } = await supabase.from('encomenda_dias')
      .delete().eq('empresa_id', empresaId).eq('dia', diaSel)
    setSalvando(false)
    if (error) { setErro(`Não consegui salvar: ${error.message}`); return }
    setMsg(`Dia ${dataBR(diaSel)} fechado para encomenda.`)
    setLimiteDia('')
    await carregar()
  }

  async function liberarLote() {
    setMsg(''); setErro('')
    const { de, ate, limite, dias } = lote
    if (!de || !ate || de > ate) { setErro('Escolha o primeiro e o último dia (o último não pode ser antes do primeiro).'); return }
    if (de < hoje) { setErro('O primeiro dia não pode ser no passado.'); return }
    if (limite === '' || Number.isNaN(Number(limite))) { setErro('Diga quantas encomendas cabem por dia (0 = sem limite).'); return }
    if (!dias.length) { setErro('Marque pelo menos um dia da semana.'); return }
    const linhas = []
    for (let d = de; d <= ate && linhas.length < 400; d = somaDias(d, 1)) {
      if (dias.includes(diaDaSemana(d))) {
        linhas.push({ empresa_id: empresaId, dia: d, liberado: true, limite: Math.max(0, Math.floor(Number(limite))) })
      }
    }
    if (!linhas.length) { setErro('Nenhum dia cai nos dias da semana marcados.'); return }
    setSalvando(true)
    const { error } = await supabase.from('encomenda_dias').upsert(linhas, { onConflict: 'empresa_id,dia' })
    setSalvando(false)
    if (error) { setErro(`Não consegui salvar: ${error.message}`); return }
    setMsg(`${linhas.length} dia${linhas.length === 1 ? '' : 's'} liberado${linhas.length === 1 ? '' : 's'}.`)
    await carregar()
  }

  async function salvarCfg() {
    setMsg(''); setErro('')
    const ant = Math.max(0, Math.floor(Number(cfg.antecedencia) || 0))
    const ent = Math.min(100, Math.max(0, Math.floor(Number(cfg.entrada) || 0)))
    setSalvando(true)
    const { error } = await supabase.from('empresas')
      .update({ encomenda_antecedencia_dias: ant, encomenda_entrada_pct: ent }).eq('id', empresaId)
    setSalvando(false)
    if (error) { setErro(`Não consegui salvar: ${error.message}`); return }
    setCfg({ antecedencia: ant, entrada: ent })
    setMsg('Regras salvas.')
  }

  const porDia = useMemo(() => {
    const m = new Map()
    for (const p of pedidos) {
      const d = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(p.agendado_para))
      if (!m.has(d)) m.set(d, [])
      m.get(d).push(p)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [pedidos])

  const infoSel = diaSel ? info(diaSel) : null

  // Serviço desligado nesta loja (só o Super Admin liga): a tela não faz nada.
  if (empresa && empresa.encomenda_ativa !== true) {
    return (
      <div className="enc-pagina">
        <div className="page-header"><h1>Encomendas</h1></div>
        <div className="card">O serviço "Vendo sob encomenda" não está ligado na sua loja.</div>
      </div>
    )
  }

  return (
    <div className="enc-pagina">
      <div className="page-header">
        <h1>Encomendas</h1>
      </div>
      <p className="enc-intro">
        Aqui você escolhe os dias em que aceita encomenda e quantas cabem em cada um. O cliente só vê os dias
        que você liberar; quando o dia enche, ele aparece como lotado.
      </p>

      {erro && <div className="card" style={{ color: 'var(--danger)' }}>{erro}</div>}
      {msg && <div className="card" style={{ color: 'var(--success)' }}>{msg}</div>}

      {!loading && (
        <div className="enc-resumo">
          <div className="enc-resumo-item">
            <b>{Object.values(agenda).filter(a => a.dia >= hoje && a.liberado !== false).length}</b>
            <span>dias liberados</span>
          </div>
          <div className="enc-resumo-item">
            <b>{pedidos.length}</b>
            <span>encomendas marcadas</span>
          </div>
          <div className="enc-resumo-item">
            <b>{cfg.antecedencia} dia{Number(cfg.antecedencia) === 1 ? '' : 's'}</b>
            <span>de antecedência</span>
          </div>
          <div className="enc-resumo-item">
            <b>{cfg.entrada}%</b>
            <span>de entrada no PIX</span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="card"><div className="skeleton-row" /><div className="skeleton-row" style={{ width: '70%' }} /></div>
      ) : (
        <>
          <div className="enc-colunas">
            <div className="card">
              <h2 className="enc-titulo"><span className="enc-num">1</span> Calendário</h2>
              <CalendarioEncomenda
                inicio={hoje}
                info={info}
                clicavel={(ymd) => ymd >= hoje}
                selecionado={diaSel}
                onEscolher={escolherDia}
                ultimoMes={12}
              />
              <div className="cal-enc-legenda">
                <span><i style={{ background: 'rgba(34,197,94,.5)' }} />Liberado (feitas/limite)</span>
                <span><i style={{ background: 'rgba(239,68,68,.45)' }} />Lotado</span>
                <span><i style={{ background: 'rgba(127,127,127,.4)' }} />Fechado</span>
              </div>
            </div>

            <div className="card">
              <h2 className="enc-titulo"><span className="enc-num">2</span> {diaSel ? `Dia ${dataBR(diaSel)}` : 'Escolha um dia'}</h2>
              {!diaSel ? (
                <div className="enc-vazio">
                  <div className="enc-vazio-icone">👈</div>
                  <p>Toque num dia do calendário para liberar, fechar ou mudar quantas encomendas cabem.</p>
                  <p className="enc-vazio-dica">Para liberar muitos dias de uma vez, use o bloco logo abaixo.</p>
                </div>
              ) : (
                <>
                  <p className="enc-dica">
                    {infoSel?.estado === 'fechado' && 'Esse dia está fechado: o cliente não consegue encomendar.'}
                    {infoSel?.estado === 'livre' && 'Esse dia está liberado para encomenda.'}
                    {infoSel?.estado === 'lotado' && 'Esse dia está lotado.'}
                    {agenda[diaSel] ? ` Já tem ${agenda[diaSel].usados} encomenda${Number(agenda[diaSel].usados) === 1 ? '' : 's'} marcada${Number(agenda[diaSel].usados) === 1 ? '' : 's'}.` : ''}
                  </p>
                  <label className="enc-campo">
                    <span>Quantas encomendas cabem nesse dia?</span>
                    <input type="number" min="0" inputMode="numeric" value={limiteDia}
                      onChange={e => setLimiteDia(e.target.value)} placeholder="Ex: 5" />
                    <small>0 = sem limite.</small>
                  </label>
                  <div className="enc-botoes">
                    <button className="btn btn-primary" onClick={liberarDia} disabled={salvando}>
                      {agenda[diaSel] ? 'Salvar limite' : 'Liberar dia'}
                    </button>
                    {agenda[diaSel] && (
                      <button className="btn btn-secondary" onClick={bloquearDia} disabled={salvando}>Fechar esse dia</button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="card">
            <h2 className="enc-titulo"><span className="enc-num">⚡</span> Liberar vários dias de uma vez</h2>
            <div className="enc-lote">
              <label className="enc-campo"><span>De</span>
                <input type="date" min={hoje} value={lote.de} onChange={e => setLote(l => ({ ...l, de: e.target.value }))} />
              </label>
              <label className="enc-campo"><span>Até</span>
                <input type="date" min={hoje} value={lote.ate} onChange={e => setLote(l => ({ ...l, ate: e.target.value }))} />
              </label>
              <label className="enc-campo"><span>Cabem por dia</span>
                <input type="number" min="0" inputMode="numeric" value={lote.limite}
                  onChange={e => setLote(l => ({ ...l, limite: e.target.value }))} placeholder="Ex: 5" />
              </label>
            </div>
            <div className="enc-rotulo">Em quais dias da semana?</div>
            <div className="enc-semana">
              {SEMANA.map((nome, i) => (
                <label key={i} className={'enc-pilula' + (lote.dias.includes(i) ? ' enc-pilula--on' : '')}>
                  <input type="checkbox" checked={lote.dias.includes(i)}
                    onChange={() => setLote(l => ({ ...l, dias: l.dias.includes(i) ? l.dias.filter(x => x !== i) : [...l.dias, i] }))} />
                  {nome.slice(0, 3)}
                </label>
              ))}
            </div>
            <div className="enc-atalhos">
              <button type="button" className="enc-atalho" onClick={() => setLote(l => ({ ...l, dias: [5, 6, 0] }))}>Sex a Dom</button>
              <button type="button" className="enc-atalho" onClick={() => setLote(l => ({ ...l, dias: [1, 2, 3, 4, 5] }))}>Seg a Sex</button>
              <button type="button" className="enc-atalho" onClick={() => setLote(l => ({ ...l, dias: [0, 1, 2, 3, 4, 5, 6] }))}>Todos</button>
            </div>
            <p className="enc-dica">Se o dia já estava liberado, o limite dele é trocado pelo novo número.</p>
            <button className="btn btn-primary" onClick={liberarLote} disabled={salvando}>Liberar esses dias</button>
          </div>

          <div className="card">
            <h2 className="enc-titulo"><span className="enc-num">⚙</span> Regras</h2>
            <div className="enc-lote">
              <label className="enc-campo"><span>Antecedência mínima (dias)</span>
                <input type="number" min="0" inputMode="numeric" value={cfg.antecedencia}
                  onChange={e => setCfg(c => ({ ...c, antecedencia: e.target.value }))} />
              </label>
              <label className="enc-campo"><span>Entrada pelo PIX (%)</span>
                <input type="number" min="0" max="100" inputMode="numeric" value={cfg.entrada}
                  onChange={e => setCfg(c => ({ ...c, entrada: e.target.value }))} />
              </label>
            </div>
            <p className="enc-dica">
              Com {cfg.entrada}% de entrada, o cliente paga essa parte na hora pelo PIX e o restante na retirada.
              O cliente não consegue encomendar para um dia mais perto do que {cfg.antecedencia} dia{Number(cfg.antecedencia) === 1 ? '' : 's'}.
            </p>
            <button className="btn btn-secondary" onClick={salvarCfg} disabled={salvando}>Salvar regras</button>
          </div>

          <div className="card">
            <h2 className="enc-titulo"><span className="enc-num">🎂</span> Encomendas marcadas</h2>
            {porDia.length === 0 ? (
              <p className="enc-dica">Nenhuma encomenda marcada daqui pra frente.</p>
            ) : porDia.map(([dia, lista]) => (
              <div key={dia} className="enc-dia-bloco">
                <div className="enc-dia-nome">{dataBR(dia)} <small>({lista.length})</small></div>
                {lista.map(p => (
                  <div key={p.id} className="enc-pedido">
                    <div>
                      <strong>#{p.numero_pedido}</strong> · {p.cliente_nome}
                      {p.observacoes ? <div className="enc-obs">{p.observacoes}</div> : null}
                    </div>
                    <div className="enc-pedido-dir">
                      {brl(p.total)}
                      <Link to={`/pedidos-delivery?busca=${p.numero_pedido}&dia=${dia}`}>Ver pedido</Link>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
