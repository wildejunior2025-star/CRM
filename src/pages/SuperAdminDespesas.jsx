import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const fmt = (v, moeda = 'BRL') =>
  Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: moeda })

const CATEGORIAS = [
  { valor: 'infra',      label: 'Infraestrutura', cor: '#3b82f6' },
  { valor: 'dominio',    label: 'Domínio',        cor: '#8b5cf6' },
  { valor: 'pagamentos', label: 'Pagamentos',     cor: '#16a34a' },
  { valor: 'app',        label: 'App / Loja',     cor: '#f97316' },
  { valor: 'ia',         label: 'IA',             cor: '#e11d48' },
  { valor: 'contador',   label: 'Contador',       cor: '#0891b2' },
  { valor: 'outro',      label: 'Outro',          cor: '#6b7280' },
]
const catInfo = c => CATEGORIAS.find(x => x.valor === c) || CATEGORIAS[6]

const RECORRENCIAS = [
  { valor: 'mensal',  label: 'Mensal'  },
  { valor: 'anual',   label: 'Anual'   },
  { valor: 'unico',   label: 'Única'   },
  { valor: 'por_uso', label: 'Por uso' },
]
const recLabel = r => (RECORRENCIAS.find(x => x.valor === r) || {}).label || r

function diasAte(dataStr) {
  if (!dataStr) return null
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
  const alvo = new Date(dataStr + 'T00:00:00')
  return Math.round((alvo - hoje) / 86400000)
}

function badgeVenc(dias) {
  if (dias === null) return null
  if (dias < 0)  return { txt: `venceu há ${Math.abs(dias)}d`, cor: '#dc2626', bg: 'rgba(220,38,38,.12)' }
  if (dias === 0) return { txt: 'vence hoje',                  cor: '#dc2626', bg: 'rgba(220,38,38,.12)' }
  if (dias <= 5) return { txt: `em ${dias}d`,                  cor: '#d97706', bg: 'rgba(217,119,6,.12)' }
  return { txt: `em ${dias}d`, cor: 'var(--text-muted)', bg: 'transparent' }
}

const inputStyle = {
  padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text)', fontSize: 13,
}

export default function SuperAdminDespesas() {
  const [lista, setLista]     = useState([])
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState(null)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('despesas_sistema')
      .select('*')
      .order('ativo', { ascending: false })
      .order('categoria')
      .order('nome')
    setLista(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function salvar(id, patch) {
    setSavingId(id)
    // otimista
    setLista(l => l.map(d => d.id === id ? { ...d, ...patch } : d))
    await supabase.from('despesas_sistema')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
    setSavingId(null)
  }

  async function adicionar() {
    const { data } = await supabase.from('despesas_sistema')
      .insert({ nome: 'Nova despesa', categoria: 'outro', recorrencia: 'mensal' })
      .select().single()
    if (data) setLista(l => [...l, data])
  }

  async function excluir(id) {
    if (!confirm('Excluir esta despesa da lista?')) return
    setLista(l => l.filter(d => d.id !== id))
    await supabase.from('despesas_sistema').delete().eq('id', id)
  }

  const ativas = lista.filter(d => d.ativo)
  const totalMensalBRL = ativas
    .filter(d => d.recorrencia === 'mensal' && d.moeda === 'BRL')
    .reduce((s, d) => s + Number(d.valor || 0), 0)
  const totalAnualBRL = ativas
    .filter(d => d.recorrencia === 'anual' && d.moeda === 'BRL')
    .reduce((s, d) => s + Number(d.valor || 0), 0)
  // custo mensal aproximado = mensais + anuais/12
  const custoMensalAprox = totalMensalBRL + totalAnualBRL / 12
  const comAlerta = ativas.filter(d => d.alerta_ativo).length

  return (
    <div className="page-container">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Despesas fixas do sistema</h1>
        <button className="btn btn-primary btn-sm" onClick={adicionar}>+ Nova despesa</button>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: -8, marginBottom: 20 }}>
        O que <strong>você paga</strong> para manter a plataforma no ar. Preencha o valor e a data de
        vencimento de cada serviço, e ligue o alerta para ser lembrado antes de cada pagamento.
      </p>

      {/* Resumo */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div style={{ background: 'var(--primary)', color: '#fff', borderRadius: 12, padding: '16px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 0.5 }}>Custo mensal aprox.</div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>{fmt(custoMensalAprox)}</div>
          <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>mensais + anuais÷12</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderLeft: '4px solid #3b82f6', borderRadius: 12, padding: '16px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Total mensal</div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>{fmt(totalMensalBRL)}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderLeft: '4px solid #8b5cf6', borderRadius: 12, padding: '16px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Total anual</div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>{fmt(totalAnualBRL)}</div>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderLeft: '4px solid #16a34a', borderRadius: 12, padding: '16px 20px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Alertas ligados</div>
          <div style={{ fontSize: 24, fontWeight: 900 }}>{comAlerta}<span style={{ fontSize: 14, color: 'var(--text-muted)' }}> / {ativas.length}</span></div>
        </div>
      </div>

      {loading ? (
        <div className="empty-state">Carregando...</div>
      ) : lista.length === 0 ? (
        <div className="empty-state">Nenhuma despesa cadastrada. Clique em “+ Nova despesa”.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {lista.map(d => {
            const cat = catInfo(d.categoria)
            const dias = badgeVenc(diasAte(d.data_vencimento))
            const naoMostraVenc = d.recorrencia === 'por_uso' || d.recorrencia === 'unico'
            return (
              <div key={d.id} style={{
                background: 'var(--card)', border: '1px solid var(--border)',
                borderLeft: `4px solid ${cat.cor}`, borderRadius: 12, padding: '14px 18px',
                opacity: d.ativo ? 1 : 0.55,
              }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                  {/* Nome */}
                  <input
                    value={d.nome}
                    onChange={e => setLista(l => l.map(x => x.id === d.id ? { ...x, nome: e.target.value } : x))}
                    onBlur={e => salvar(d.id, { nome: e.target.value })}
                    style={{ ...inputStyle, flex: '1 1 200px', fontWeight: 700, fontSize: 14 }}
                  />
                  {/* Categoria */}
                  <select value={d.categoria} onChange={e => salvar(d.id, { categoria: e.target.value })} style={{ ...inputStyle }}>
                    {CATEGORIAS.map(c => <option key={c.valor} value={c.valor}>{c.label}</option>)}
                  </select>
                  {/* Recorrência */}
                  <select value={d.recorrencia} onChange={e => salvar(d.id, { recorrencia: e.target.value })} style={{ ...inputStyle }}>
                    {RECORRENCIAS.map(r => <option key={r.valor} value={r.valor}>{r.label}</option>)}
                  </select>
                  {/* Valor */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <select value={d.moeda} onChange={e => salvar(d.id, { moeda: e.target.value })} style={{ ...inputStyle, padding: '5px 4px' }}>
                      <option value="BRL">R$</option>
                      <option value="USD">US$</option>
                    </select>
                    <input
                      type="number" min="0" step="0.01" placeholder="0,00"
                      value={d.valor ?? ''}
                      onChange={e => setLista(l => l.map(x => x.id === d.id ? { ...x, valor: e.target.value } : x))}
                      onBlur={e => salvar(d.id, { valor: e.target.value === '' ? null : Number(e.target.value) })}
                      style={{ ...inputStyle, width: 90, textAlign: 'right' }}
                    />
                  </div>
                  {/* Vencimento */}
                  {!naoMostraVenc && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="date"
                        value={d.data_vencimento ?? ''}
                        onChange={e => salvar(d.id, { data_vencimento: e.target.value || null })}
                        style={{ ...inputStyle }}
                      />
                      {dias && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: dias.cor, background: dias.bg, padding: '2px 7px', borderRadius: 20, whiteSpace: 'nowrap' }}>
                          {dias.txt}
                        </span>
                      )}
                    </div>
                  )}
                  {naoMostraVenc && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      {recLabel(d.recorrencia)} — sem vencimento fixo
                    </span>
                  )}
                  {/* Ações à direita */}
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                    {savingId === d.id && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>salvando…</span>}
                    {/* Alerta */}
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer', userSelect: 'none' }}>
                      <input
                        type="checkbox"
                        checked={!!d.alerta_ativo}
                        disabled={naoMostraVenc}
                        onChange={e => salvar(d.id, { alerta_ativo: e.target.checked })}
                      />
                      <span style={{ color: d.alerta_ativo ? 'var(--primary)' : 'var(--text-muted)', fontWeight: 600 }}>
                        🔔 Alerta
                      </span>
                    </label>
                    {d.alerta_ativo && !naoMostraVenc && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 12, color: 'var(--text-muted)' }}>
                        <input
                          type="number" min="0" max="60"
                          value={d.alerta_dias_antes ?? 3}
                          onChange={e => setLista(l => l.map(x => x.id === d.id ? { ...x, alerta_dias_antes: e.target.value } : x))}
                          onBlur={e => salvar(d.id, { alerta_dias_antes: Number(e.target.value || 0) })}
                          style={{ ...inputStyle, width: 48, textAlign: 'right', padding: '3px 6px' }}
                        />
                        dias antes
                      </span>
                    )}
                    {/* Ativo/inativo */}
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => salvar(d.id, { ativo: !d.ativo })}
                      title={d.ativo ? 'Marcar como inativa' : 'Reativar'}
                    >
                      {d.ativo ? 'Ativa' : 'Inativa'}
                    </button>
                    <button
                      onClick={() => excluir(d.id)}
                      title="Excluir"
                      style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {/* Observações */}
                <input
                  value={d.observacoes ?? ''}
                  placeholder="Observação (ex: cartão usado, onde pagar, link…)"
                  onChange={e => setLista(l => l.map(x => x.id === d.id ? { ...x, observacoes: e.target.value } : x))}
                  onBlur={e => salvar(d.id, { observacoes: e.target.value })}
                  style={{ ...inputStyle, width: '100%', marginTop: 10, border: 'none', borderTop: '1px solid var(--border)', borderRadius: 0, background: 'transparent', color: 'var(--text-muted)', paddingLeft: 0 }}
                />
              </div>
            )
          })}
        </div>
      )}

      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 20 }}>
        Serviços “por uso” (Mercado Pago, Efí, IA, WhatsApp Cloud) não têm vencimento fixo — cobram por
        transação/uso, então ficam aqui só como referência de custo.
      </p>
    </div>
  )
}
