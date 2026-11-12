import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// Maquininha Mercado Pago Point (mig 0447) — fica em Loja → Pagamento.
//
// É uma conexão SEPARADA da do PIX: o Mercado Pago só libera maquininha pra um
// app de "pagamentos presenciais" (FWC Inter Maquininha), e o do PIX é de
// pagamentos online. A loja pode ter um, o outro ou os dois.
//
// Três passos pra loja:
//   1. Conectar (login no Mercado Pago, o mesmo da maquininha).
//   2. Buscar as maquininhas da conta e dar um apelido ("Caixa", "Garçom 1").
//   3. Ligar o modo PDV em cada uma — é o que deixa ela receber cobrança do sistema.
// Depois disso o botão "Cobrar na maquininha" aparece no fechamento da mesa.

const FN_BASE = import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'

const MODO_TXT = {
  PDV: { txt: 'Modo PDV ✓ recebe do sistema', cor: '#16a34a' },
  STANDALONE: { txt: 'Modo avulso: ainda não recebe do sistema', cor: '#d97706' },
}

export default function CardMaquininha({ empresa, refreshProfile }) {
  const conectado = !!empresa?.mp_point_conectado
  const [msg, setMsg] = useState(null)              // { tipo: 'ok'|'erro', texto }
  const [ocupado, setOcupado] = useState(false)
  const [lista, setLista] = useState([])
  const [apelidos, setApelidos] = useState({})

  // Volta do Mercado Pago (?mp_point=ok / ?mp_point=erro)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('mp_point')
    if (p === 'ok') { setMsg({ tipo: 'ok', texto: 'Maquininha conectada! Agora toque em "Buscar minhas maquininhas".' }); refreshProfile?.() }
    else if (p === 'erro') setMsg({ tipo: 'erro', texto: 'Não deu pra conectar. Tente de novo, entrando com a conta do Mercado Pago da maquininha.' })
    if (p) window.history.replaceState({}, '', window.location.pathname)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function carregar() {
    if (!empresa?.id) return
    const { data } = await supabase.from('maquininhas')
      .select('id, terminal_id, apelido, modo, ativa').eq('empresa_id', empresa.id).order('created_at')
    setLista(data ?? [])
    setApelidos(Object.fromEntries((data ?? []).map(m => [m.id, m.apelido ?? ''])))
  }

  useEffect(() => { if (conectado) carregar() }, [conectado, empresa?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function sessaoToken() {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? ''
  }

  async function conectar() {
    setOcupado(true); setMsg(null)
    try {
      const returnUrl = window.location.origin + window.location.pathname
      const res = await fetch(`${FN_BASE}/functions/v1/mercadopago-oauth?action=start&app=point&return_url=${encodeURIComponent(returnUrl)}`,
        { headers: { Authorization: `Bearer ${await sessaoToken()}` } })
      const data = await res.json()
      if (data.url) { window.location.href = data.url; return }
      setMsg({ tipo: 'erro', texto: data.error || 'Erro ao iniciar a conexão.' })
    } catch {
      setMsg({ tipo: 'erro', texto: 'Erro ao conectar. Verifique a internet.' })
    }
    setOcupado(false)
  }

  async function desconectar() {
    if (!window.confirm('Desconectar a maquininha? O botão "Cobrar na maquininha" some das mesas.')) return
    setOcupado(true); setMsg(null)
    try {
      const res = await fetch(`${FN_BASE}/functions/v1/mercadopago-oauth?action=disconnect&app=point`,
        { method: 'POST', headers: { Authorization: `Bearer ${await sessaoToken()}` } })
      if (res.ok) { setMsg({ tipo: 'ok', texto: 'Maquininha desconectada.' }); await refreshProfile?.() }
      else setMsg({ tipo: 'erro', texto: 'Erro ao desconectar.' })
    } catch {
      setMsg({ tipo: 'erro', texto: 'Erro ao desconectar.' })
    }
    setOcupado(false)
  }

  async function chamar(body) {
    const { data, error } = await supabase.functions.invoke('comanda-maquininha', { body })
    const erro = data?.error ?? (error ? (await error.context?.json?.().catch(() => null))?.error ?? 'Não deu certo. Tente de novo.' : null)
    return { data, erro }
  }

  async function buscar() {
    setOcupado(true); setMsg(null)
    const { data, erro } = await chamar({ acao: 'terminais' })
    if (erro) setMsg({ tipo: 'erro', texto: erro })
    else if (!data?.total_mp) setMsg({ tipo: 'erro', texto: 'O Mercado Pago não achou maquininha nesta conta. Confira se a Point está vinculada a esta mesma conta (no app do Mercado Pago → Maquininhas).' })
    else setMsg({ tipo: 'ok', texto: `Achei ${data.total_mp} maquininha(s).` })
    await carregar()
    setOcupado(false)
  }

  async function ligarPdv(m) {
    if (!window.confirm('Ligar o modo PDV nesta maquininha?\n\nEla vai REINICIAR. Depois disso ela passa a receber as cobranças que o garçom manda pelo sistema.\n\nFaça isso com a loja parada, não no meio do movimento.')) return
    setOcupado(true); setMsg(null)
    const { erro } = await chamar({ acao: 'modo_pdv', maquininha_id: m.id })
    setMsg(erro ? { tipo: 'erro', texto: erro } : { tipo: 'ok', texto: 'Pronto! A maquininha vai reiniciar já no modo PDV.' })
    await carregar()
    setOcupado(false)
  }

  async function salvarApelido(m) {
    const novo = (apelidos[m.id] ?? '').trim()
    if (novo === (m.apelido ?? '')) return
    await supabase.from('maquininhas').update({ apelido: novo || null }).eq('id', m.id)
    await carregar()
  }

  async function alternarAtiva(m) {
    await supabase.from('maquininhas').update({ ativa: !m.ativa }).eq('id', m.id)
    await carregar()
  }

  const botao = (cor) => ({
    fontSize: 13, fontWeight: 700, padding: '8px 14px', borderRadius: 8, cursor: ocupado ? 'wait' : 'pointer',
    border: cor ? 'none' : '1px solid var(--border)', background: cor ?? 'transparent', color: cor ? '#fff' : 'var(--text-muted)',
  })

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>💳 Cobrar na maquininha (Mercado Pago Point)</h2>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 14 }}>
        O garçom aperta <strong>"Cobrar na maquininha"</strong> na mesa, o valor da conta aparece na
        maquininha, o cliente paga e a <strong>mesa fecha sozinha</strong>. O dinheiro cai na conta
        Mercado Pago da loja, com as taxas de sempre.
      </p>

      {msg && (
        <div style={{
          fontSize: 13, fontWeight: 600, padding: '10px 12px', borderRadius: 8, marginBottom: 12,
          background: msg.tipo === 'ok' ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
          color: msg.tipo === 'ok' ? '#16a34a' : '#dc2626',
        }}>{msg.texto}</div>
      )}

      {!conectado ? (
        <button type="button" onClick={conectar} disabled={ocupado} style={{ ...botao('#009ee3'), fontSize: 14, padding: '10px 18px' }}>
          {ocupado ? 'Abrindo o Mercado Pago...' : 'Conectar a maquininha'}
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#16a34a' }}>● Conta conectada ✓</span>
            <button type="button" onClick={buscar} disabled={ocupado} style={botao('#009ee3')}>
              {ocupado ? 'Aguarde...' : '🔎 Buscar minhas maquininhas'}
            </button>
            <button type="button" onClick={desconectar} disabled={ocupado} style={botao()}>Desconectar</button>
          </div>

          {lista.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Nenhuma maquininha ainda. Toque em "Buscar minhas maquininhas".
            </div>
          )}

          {lista.map((m, i) => {
            const modo = MODO_TXT[m.modo] ?? { txt: 'Modo desconhecido', cor: 'var(--text-muted)' }
            return (
              <div key={m.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 8, opacity: m.ativa ? 1 : .6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text" value={apelidos[m.id] ?? ''} maxLength={30}
                    placeholder={`Apelido (ex.: Caixa, Garçom ${i + 1})`}
                    onChange={e => setApelidos(a => ({ ...a, [m.id]: e.target.value }))}
                    onBlur={() => salvarApelido(m)}
                    // Este card mora dentro do formulário da loja: Enter aqui não pode salvar a loja inteira.
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
                    style={{ flex: '1 1 180px', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }}
                  />
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={m.ativa} onChange={() => alternarAtiva(m)} />
                    Usar nas mesas
                  </label>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, wordBreak: 'break-all' }}>{m.terminal_id}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: modo.cor }}>{modo.txt}</span>
                  {m.modo !== 'PDV' && (
                    <button type="button" onClick={() => ligarPdv(m)} disabled={ocupado} style={{ ...botao('#16a34a'), padding: '6px 12px', fontSize: 12.5 }}>
                      Ligar modo PDV
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
