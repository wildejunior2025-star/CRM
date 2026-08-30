// Super Admin → Assistente IA.
//
// O que os lojistas estão perguntando pro robô do Portal — e quanto isso custa.
//
// Por que esta tela existe: as perguntas são o melhor mapa de onde o sistema
// confunde, e ela se escreve sozinha. Dez lojistas perguntando "como emito
// nota fiscal?" é uma tela mal resolvida ou um vídeo faltando. Pergunta que a
// IA não soube responder é ferramenta faltando nela.
//
// O custo por pergunta fica gravado junto (a edge function calcula na hora, com
// os tokens que a API devolve). Com um mês disso, trocar de modelo pra economizar
// vira decisão com número na mão em vez de chute.

import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import '../components/Page.css'

const usd = (v) => 'US$ ' + Number(v || 0).toFixed(2)
const dataHora = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

const PERIODOS = [['7', '7 dias'], ['30', '30 dias'], ['90', '90 dias'], ['0', 'Tudo']]

export default function SuperAdminAssistente() {
  const [linhas, setLinhas] = useState([])
  const [empresas, setEmpresas] = useState({})
  const [dias, setDias] = useState('30')
  const [empresaFiltro, setEmpresaFiltro] = useState('')
  const [busca, setBusca] = useState('')
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    let cancelado = false
    async function carregar() {
      setLoading(true); setErro(null)
      let q = () => {
        // Sem paginar, uma base movimentada cortaria em 1000 e o custo do mês
        // apareceria MENOR do que é — o erro exato que já aconteceu no resumo.
        let base = supabase.from('assistente_conversas')
          .select('id, empresa_id, pergunta, resposta, consultas, custo_usd, tokens_in, tokens_cache, tokens_out, modelo, oculto_em, created_at')
          .order('created_at', { ascending: false })
        if (dias !== '0') {
          const desde = new Date(); desde.setDate(desde.getDate() - Number(dias))
          base = base.gte('created_at', desde.toISOString())
        }
        return base
      }
      const [{ data, error }, emp] = await Promise.all([
        fetchAll(q),
        supabase.from('empresas').select('id, nome'),
      ])
      if (cancelado) return
      if (error) setErro(error.message)
      setLinhas(data ?? [])
      setEmpresas(Object.fromEntries((emp.data ?? []).map(e => [e.id, e.nome])))
      setLoading(false)
    }
    carregar()
    return () => { cancelado = true }
  }, [dias])

  const filtradas = useMemo(() => {
    const t = busca.trim().toLowerCase()
    return linhas.filter(l =>
      (!empresaFiltro || l.empresa_id === empresaFiltro) &&
      (!t || l.pergunta.toLowerCase().includes(t) || l.resposta.toLowerCase().includes(t))
    )
  }, [linhas, empresaFiltro, busca])

  const resumo = useMemo(() => {
    const custo = filtradas.reduce((s, l) => s + Number(l.custo_usd || 0), 0)
    const lojas = new Set(filtradas.map(l => l.empresa_id))
    // Quanto do que a IA leu veio do cache. Abaixo de uns 50% tem prompt novo
    // sendo montado a cada pergunta — é dinheiro indo embora sem motivo.
    const lidos = filtradas.reduce((s, l) => s + Number(l.tokens_cache || 0), 0)
    const entrada = filtradas.reduce((s, l) => s + Number(l.tokens_in || 0), 0)
    return {
      perguntas: filtradas.length,
      custo,
      media: filtradas.length ? custo / filtradas.length : 0,
      lojas: lojas.size,
      cachePct: (lidos + entrada) ? Math.round((lidos / (lidos + entrada)) * 100) : 0,
    }
  }, [filtradas])

  // Ranking do que mais perguntam. Agrupa pelas primeiras palavras porque
  // ninguém escreve a pergunta igual duas vezes — não é exato, é um cheiro.
  const maisPerguntado = useMemo(() => {
    const agg = {}
    for (const l of filtradas) {
      const k = l.pergunta.toLowerCase().replace(/[?!.,]/g, '').split(/\s+/).slice(0, 4).join(' ')
      ;(agg[k] ??= { texto: l.pergunta, n: 0 }).n++
    }
    return Object.values(agg).sort((a, b) => b.n - a.n).filter(x => x.n > 1).slice(0, 8)
  }, [filtradas])

  const lojasComUso = useMemo(() => {
    const agg = {}
    for (const l of filtradas) {
      const k = l.empresa_id
      agg[k] ??= { nome: empresas[k] ?? 'Loja', n: 0, custo: 0 }
      agg[k].n++; agg[k].custo += Number(l.custo_usd || 0)
    }
    return Object.entries(agg).sort((a, b) => b[1].n - a[1].n)
  }, [filtradas, empresas])

  return (
    <div>
      <div className="page-header"><h1>Assistente IA</h1></div>
      <p style={{ fontSize: 13.5, color: 'var(--text-muted)', margin: '-10px 0 18px' }}>
        O que os lojistas estão perguntando pro robô do Portal — e quanto está custando.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        {PERIODOS.map(([id, lb]) => (
          <button key={id} type="button" onClick={() => setDias(id)} style={chip(dias === id)}>{lb}</button>
        ))}
        <select value={empresaFiltro} onChange={e => setEmpresaFiltro(e.target.value)} style={campo}>
          <option value="">Todas as lojas</option>
          {lojasComUso.map(([id, v]) => <option key={id} value={id}>{v.nome}</option>)}
        </select>
        <input type="search" value={busca} onChange={e => setBusca(e.target.value)}
          placeholder="Buscar na pergunta ou na resposta…" style={{ ...campo, minWidth: 240, flex: 1 }} />
      </div>

      {erro && <p style={{ color: 'var(--danger)' }}>{erro}</p>}
      {loading ? <p style={{ color: 'var(--text-muted)' }}>Carregando…</p> : (
        <>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 20 }}>
            <Cartao rotulo="Perguntas" valor={resumo.perguntas} />
            <Cartao rotulo="Lojas usando" valor={resumo.lojas} />
            <Cartao rotulo="Custo no período" valor={usd(resumo.custo)} />
            <Cartao rotulo="Custo por pergunta" valor={usd(resumo.media)} />
            <Cartao rotulo="Lido do cache" valor={resumo.cachePct + '%'}
              dica="Quanto do prompt veio do cache (custa 10%). Quanto maior, melhor." />
          </div>

          {maisPerguntado.length > 0 && (
            <div style={caixa}>
              <h2 style={titulo}>O que mais perguntam</h2>
              <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                Pergunta repetida é tela confusa ou vídeo faltando. É por aqui que vale começar.
              </p>
              {maisPerguntado.map((p, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, padding: '6px 0', fontSize: 13.5, borderTop: i ? '1px solid var(--border)' : 'none' }}>
                  <strong style={{ minWidth: 28 }}>{p.n}×</strong>
                  <span>{p.texto}</span>
                </div>
              ))}
            </div>
          )}

          {lojasComUso.length > 0 && (
            <div style={caixa}>
              <h2 style={titulo}>Por loja</h2>
              {lojasComUso.map(([id, v], i) => (
                <div key={id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', fontSize: 13.5, borderTop: i ? '1px solid var(--border)' : 'none' }}>
                  <span>{v.nome}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{v.n} perguntas · {usd(v.custo)}</span>
                </div>
              ))}
            </div>
          )}

          <div style={caixa}>
            <h2 style={titulo}>Conversas</h2>
            {filtradas.length === 0 && <p style={{ fontSize: 13.5, color: 'var(--text-muted)' }}>Nada no período.</p>}
            {filtradas.map(l => (
              <div key={l.id} style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>
                  <strong style={{ color: 'var(--text)' }}>{empresas[l.empresa_id] ?? 'Loja'}</strong>
                  <span>{dataHora(l.created_at)}</span>
                  <span>{usd(l.custo_usd)}</span>
                  {(l.consultas ?? []).map(c => <span key={c} style={etiqueta}>{c}</span>)}
                  {/* Quem limpou não apagou: some da tela dele, fica aqui. */}
                  {l.oculto_em && <span style={{ ...etiqueta, opacity: .7 }}>limpou da tela dele</span>}
                </div>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>{l.pergunta}</div>
                <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>{l.resposta}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function Cartao({ rotulo, valor, dica }) {
  return (
    <div style={{ ...caixa, marginBottom: 0 }} title={dica}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{rotulo}</div>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{valor}</div>
    </div>
  )
}

const caixa = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 14, padding: 16, marginBottom: 18,
}
const titulo = { fontSize: 15, fontWeight: 700, margin: '0 0 8px' }
const campo = {
  padding: '8px 12px', borderRadius: 9, fontSize: 13.5,
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
}
const chip = (ativo) => ({
  padding: '8px 16px', borderRadius: 9, cursor: 'pointer', fontSize: 13.5, fontWeight: 700,
  border: '1px solid var(--border)',
  background: ativo ? 'var(--primary)' : 'var(--surface)',
  color: ativo ? 'var(--primary-contrast)' : 'var(--text)',
})
const etiqueta = {
  padding: '1px 7px', borderRadius: 999, fontSize: 11,
  background: 'var(--primary-bg)', color: 'var(--primary)',
}
