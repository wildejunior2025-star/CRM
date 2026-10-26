import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { fwcFetch } from '../lib/appFwc'
import './RaioEntrega.css'

const fmtBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const fmtDataHora = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })

// Mês corrente no fuso de Brasília, no formato AAAA-MM
function mesAtual() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date())
  return p.slice(0, 7)
}

// Brasília é UTC-3 o ano todo (sem horário de verão)
function janelaDoMes(mes) {
  const [a, m] = mes.split('-').map(Number)
  return [new Date(Date.UTC(a, m - 1, 1, 3)).toISOString(), new Date(Date.UTC(a, m, 1, 3)).toISOString()]
}

const STATUS = {
  autorizada: { txt: 'Autorizada', cor: 'var(--success)', bg: 'var(--success-bg)' },
  cancelada: { txt: 'Cancelada', cor: 'var(--text-muted)', bg: 'var(--bg)' },
  rejeitada: { txt: 'Rejeitada', cor: 'var(--danger)', bg: 'var(--danger-bg)' },
  processando: { txt: 'Processando', cor: 'var(--primary)', bg: 'var(--primary-bg)' },
}

export default function NotasFiscais() {
  const { profile } = useAuth()
  const [mes, setMes] = useState(mesAtual)
  const [notas, setNotas] = useState([])
  const [pedidos, setPedidos] = useState({})
  const [carregando, setCarregando] = useState(true)
  const [ocupado, setOcupado] = useState(null) // id da nota em ação, ou 'zip'
  const [msg, setMsg] = useState(null)

  async function carregar() {
    if (!profile?.empresa_id) return
    setCarregando(true)
    const [ini, fim] = janelaDoMes(mes)
    const { data } = await supabase.from('nfce_notas')
      .select('id, pedido_id, comanda_id, status, ambiente, numero, serie, chave_acesso, protocolo, qrcode_url, xml_url, danfe_url, valor_total, tributos_valor, tributos_fonte, motivo_rejeicao, created_at')
      .eq('empresa_id', profile.empresa_id)
      .gte('created_at', ini).lt('created_at', fim)
      .order('created_at', { ascending: false })
      .limit(2000)
    const lista = data ?? []
    setNotas(lista)
    const ids = [...new Set(lista.map(n => n.pedido_id).filter(Boolean))]
    const mapa = {}
    for (let i = 0; i < ids.length; i += 200) {
      const { data: peds } = await supabase.from('pedidos_delivery')
        .select('id, numero_pedido, cliente_nome, forma_pagamento').in('id', ids.slice(i, i + 200))
      for (const p of peds ?? []) mapa[p.id] = p
    }
    setPedidos(mapa)
    setCarregando(false)
  }
  useEffect(() => { carregar() }, [profile?.empresa_id, mes]) // eslint-disable-line react-hooks/exhaustive-deps

  // Nota de teste (homologação) não tem valor fiscal: fica fora dos totais.
  const resumo = useMemo(() => {
    const r = { aut: 0, valor: 0, canc: 0, rej: 0, proc: 0, teste: 0 }
    for (const n of notas) {
      if (n.ambiente !== 'producao') { r.teste++; continue }
      if (n.status === 'autorizada') { r.aut++; r.valor += Number(n.valor_total) || 0 }
      else if (n.status === 'cancelada') r.canc++
      else if (n.status === 'rejeitada') r.rej++
      else r.proc++
    }
    return r
  }, [notas])

  async function chamar(corpo) {
    const { data: { session } } = await supabase.auth.getSession()
    const base = import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'
    return fetch(`${base}/functions/v1/emitir-nfce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(corpo),
    }).then(r => r.json())
  }

  // SEGUNDA VIA DO CUPOM FISCAL
  //
  // O cliente tem direito a pedir de novo, e ate hoje a unica saida era abrir o
  // HTML do emissor e mandar pra impressora comum — que cospe uma folha A4 com
  // o QR minusculo. Aqui vai pra termica, no mesmo formato da 1a via, com o QR
  // desenhado pela propria impressora.
  //
  // Os itens vem da venda que gerou a nota: pedido de delivery/balcao ou
  // comanda de mesa, conforme o caso.
  async function imprimir(n) {
    setOcupado(n.id); setMsg(null)
    try {
      let itens = []
      let forma = null
      if (n.comanda_id) {
        const { data: its } = await supabase.from('comanda_itens')
          .select('nome, quantidade, preco_unitario, status').eq('comanda_id', n.comanda_id)
        itens = (its ?? []).filter(i => i.status !== 'cancelado')
          .map(i => ({ nome: i.nome, quantidade: i.quantidade, preco: i.preco_unitario }))
        const { data: c } = await supabase.from('comandas').select('forma_pagamento').eq('id', n.comanda_id).maybeSingle()
        forma = c?.forma_pagamento ?? null
      } else if (n.pedido_id) {
        const { data: ped } = await supabase.from('pedidos_delivery')
          .select('itens, forma_pagamento').eq('id', n.pedido_id).maybeSingle()
        itens = (ped?.itens ?? []).map(i => ({
          nome: i.nome ?? i.descricao, quantidade: i.quantidade ?? 1, preco: i.preco_unitario ?? i.preco ?? 0,
        }))
        forma = ped?.forma_pagamento ?? null
      }
      const { data: emp } = await supabase.from('empresas')
        .select('nome, razao_social, cnpj, endereco, numero, bairro, cidade, estado').eq('id', profile.empresa_id).maybeSingle()

      const r = await fwcFetch('/api/imprimir-nfce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nota: { ...n, forma_pagamento: forma, emitida_em: fmtDataHora(n.created_at) },
          empresa: emp, itens, segunda_via: true,
        }),
      })
      const j = await r.json()
      setMsg(j?.ok
        ? { ok: true, txt: 'Cupom enviado para a impressora.' }
        : { ok: false, txt: j?.erro === 'sem impressora' ? 'Nenhuma impressora configurada neste computador.' : (j?.erro || 'O app Impressora FWC deste computador está desatualizado. Feche ele pelo ícone perto do relógio e abra de novo — ele se atualiza sozinho.') })
    } catch (e) {
      setMsg({ ok: false, txt: 'O navegador não chegou no app Impressora FWC deste computador. Confira se ele está aberto e, se estiver, clique no cadeado ao lado do endereço do site → Configurações do site → "Rede local" → Permitir, e tente de novo.' })
    } finally { setOcupado(null) }
  }

  async function consultar(n) {
    setOcupado(n.id); setMsg(null)
    try {
      const r = await chamar({ acao: 'consultar', nota_id: n.id })
      setMsg({ ok: !!r?.ok, txt: r?.ok ? 'Nota autorizada.' : (r?.error || `Situação: ${r?.status ?? 'sem resposta'}`) })
      await carregar()
    } catch (e) { setMsg({ ok: false, txt: String(e) }) } finally { setOcupado(null) }
  }

  async function cancelar(n) {
    const motivo = window.prompt(`Cancelar a nota ${n.numero}?\n\nEscreva o motivo (mínimo 15 letras). Só dá certo dentro do prazo da SEFAZ.`)
    if (motivo === null) return
    setOcupado(n.id); setMsg(null)
    try {
      const r = await chamar({ acao: 'cancelar', nota_id: n.id, justificativa: motivo })
      setMsg({ ok: !!r?.ok, txt: r?.ok ? 'Nota cancelada.' : (r?.error || 'Não foi possível cancelar.') })
      await carregar()
    } catch (e) { setMsg({ ok: false, txt: String(e) }) } finally { setOcupado(null) }
  }

  async function baixarZip() {
    setOcupado('zip'); setMsg(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const base = import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'
      const r = await fetch(`${base}/functions/v1/nfce-zip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ mes }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setMsg({ ok: false, txt: j?.error || `Erro ${r.status}` })
        return
      }
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `nfce-${mes}.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } catch (e) { setMsg({ ok: false, txt: String(e) }) } finally { setOcupado(null) }
  }

  async function baixarPlanilha() {
    const XLSX = await import('xlsx')
    const linhas = notas.map(n => {
      const p = pedidos[n.pedido_id] ?? {}
      return {
        'Data': fmtDataHora(n.created_at),
        'Nº nota': n.numero ?? '',
        'Série': n.serie ?? '',
        'Pedido': p.numero_pedido ?? '',
        'Cliente': p.cliente_nome ?? '',
        'Forma de pagamento': p.forma_pagamento ?? '',
        'Valor': Number(n.valor_total) || 0,
        'Situação': STATUS[n.status]?.txt ?? n.status,
        'Ambiente': n.ambiente === 'producao' ? 'Produção' : 'Teste (sem valor fiscal)',
        'Chave de acesso': n.chave_acesso ?? '',
      }
    })
    const ws = XLSX.utils.json_to_sheet(linhas)
    ws['!cols'] = [{ wch: 16 }, { wch: 9 }, { wch: 6 }, { wch: 8 }, { wch: 22 }, { wch: 16 }, { wch: 11 }, { wch: 12 }, { wch: 22 }, { wch: 46 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'NFC-e')
    XLSX.writeFile(wb, `nfce-${mes}.xlsx`)
  }

  const cartao = { padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', minWidth: 120, flex: '1 1 120px' }

  return (
    <div className="re-page" style={{ maxWidth: 980 }}>
      <div className="card">
        <h2 className="re-card-title" style={{ marginBottom: 6 }}>Notas fiscais (NFC-e)</h2>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-muted)' }}>
          Tudo que a loja emitiu, por mês — pra conferir com o faturamento e mandar pro contador.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="month" value={mes} max={mesAtual()} onChange={e => e.target.value && setMes(e.target.value)}
            style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', color: 'var(--text)' }} />
          <button className="btn btn-primary btn-sm" disabled={!notas.length || ocupado === 'zip'} onClick={baixarZip}>
            {ocupado === 'zip' ? 'Montando…' : '⬇ XMLs do mês (.zip)'}
          </button>
          <button className="btn btn-secondary btn-sm" disabled={!notas.length} onClick={baixarPlanilha}>⬇ Planilha (.xlsx)</button>
        </div>
        {msg && (
          <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: 13, background: msg.ok ? 'var(--success-bg)' : 'var(--danger-bg)', color: msg.ok ? 'var(--success)' : 'var(--danger)' }}>
            {msg.txt}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={cartao}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Autorizadas</div><div style={{ fontSize: 22, fontWeight: 700 }}>{resumo.aut}</div></div>
        <div style={cartao}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Valor emitido</div><div style={{ fontSize: 22, fontWeight: 700 }}>{fmtBRL(resumo.valor)}</div></div>
        <div style={cartao}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Canceladas</div><div style={{ fontSize: 22, fontWeight: 700 }}>{resumo.canc}</div></div>
        <div style={cartao}><div style={{ fontSize: 12, color: resumo.rej ? 'var(--danger)' : 'var(--text-muted)' }}>Rejeitadas</div><div style={{ fontSize: 22, fontWeight: 700, color: resumo.rej ? 'var(--danger)' : undefined }}>{resumo.rej}</div></div>
        {resumo.proc > 0 && <div style={cartao}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Processando</div><div style={{ fontSize: 22, fontWeight: 700 }}>{resumo.proc}</div></div>}
        {resumo.teste > 0 && <div style={cartao}><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>De teste (fora dos totais)</div><div style={{ fontSize: 22, fontWeight: 700 }}>{resumo.teste}</div></div>}
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        {carregando ? (
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Carregando…</p>
        ) : !notas.length ? (
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Nenhuma nota neste mês. Pra emitir, use o botão 🧾 NFC-e no pedido.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '6px 8px' }}>Data</th>
                <th style={{ padding: '6px 8px' }}>Nota</th>
                <th style={{ padding: '6px 8px' }}>Pedido</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Valor</th>
                <th style={{ padding: '6px 8px' }}>Situação</th>
                <th style={{ padding: '6px 8px' }}></th>
              </tr>
            </thead>
            <tbody>
              {notas.map(n => {
                const st = STATUS[n.status] ?? STATUS.processando
                const p = pedidos[n.pedido_id] ?? {}
                const teste = n.ambiente !== 'producao'
                return (
                  <tr key={n.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{fmtDataHora(n.created_at)}</td>
                    <td style={{ padding: '8px' }}>
                      {n.numero ? `${n.numero}/${n.serie ?? 1}` : '—'}
                      {teste && <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', borderRadius: 6, background: 'var(--bg)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>teste</span>}
                    </td>
                    <td style={{ padding: '8px' }}>{p.numero_pedido ? `#${p.numero_pedido}` : '—'}{p.cliente_nome ? ` · ${p.cliente_nome}` : ''}</td>
                    <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtBRL(n.valor_total)}</td>
                    <td style={{ padding: '8px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600, color: st.cor, background: st.bg }}>{st.txt}</span>
                      {n.status === 'rejeitada' && n.motivo_rejeicao && (
                        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 3, maxWidth: 260 }}>{n.motivo_rejeicao}</div>
                      )}
                    </td>
                    <td style={{ padding: '8px', whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {n.danfe_url && <a href={n.danfe_url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" style={{ padding: '3px 9px', marginRight: 6 }}>Cupom</a>}
                      {n.status === 'autorizada' && (
                        <button className="btn btn-secondary btn-sm" disabled={ocupado === n.id} onClick={() => imprimir(n)} style={{ padding: '3px 9px', marginRight: 6 }}>
                          🖨️ 2ª via
                        </button>
                      )}
                      {n.xml_url && <a href={n.xml_url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm" style={{ padding: '3px 9px', marginRight: 6 }}>XML</a>}
                      {n.status === 'processando' && (
                        <button className="btn btn-secondary btn-sm" disabled={ocupado === n.id} onClick={() => consultar(n)} style={{ padding: '3px 9px' }}>
                          {ocupado === n.id ? '…' : 'Atualizar'}
                        </button>
                      )}
                      {n.status === 'autorizada' && (
                        <button className="btn btn-secondary btn-sm" disabled={ocupado === n.id} onClick={() => cancelar(n)} style={{ padding: '3px 9px', color: 'var(--danger)' }}>
                          {ocupado === n.id ? '…' : 'Cancelar'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
