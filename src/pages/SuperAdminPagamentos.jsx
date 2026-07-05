import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'
import './SuperAdminPagamentos.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL

const FORMAS = [
  { value: 'pix_chave',     label: 'PIX — Chave' },
  { value: 'pix_copia_cola', label: 'PIX — Copia e Cola' },
  { value: 'boleto',        label: 'Boleto' },
  { value: 'transferencia', label: 'Transferência' },
]
const RECORRENCIAS = [
  { value: 'unico',     label: 'Pagamento único' },
  { value: 'semanal',   label: 'Semanal' },
  { value: 'quinzenal', label: 'Quinzenal' },
  { value: 'mensal',    label: 'Mensal' },
]
const TIPO_CHAVES = ['CPF', 'CNPJ', 'E-mail', 'Telefone', 'Chave aleatória']

const STATUS_STYLE = {
  pendente:  { bg: 'rgba(234,179,8,.15)',   color: '#ca8a04', label: 'Pendente' },
  atrasado:  { bg: 'rgba(239,68,68,.15)',   color: '#dc2626', label: 'Atrasado' },
  pago:      { bg: 'rgba(34,197,94,.15)',   color: '#16a34a', label: 'Pago' },
  cancelado: { bg: 'rgba(107,114,128,.15)', color: '#6b7280', label: 'Cancelado' },
}
const FORMA_LABEL = {
  pix_chave:     'PIX Chave',
  pix_copia_cola:'PIX Copia e Cola',
  boleto:        'Boleto',
  transferencia: 'Transferência',
}

function fmt(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}
function addDays(date, days) {
  const d = new Date(date); d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}
function addMonths(date, months) {
  const d = new Date(date); d.setMonth(d.getMonth() + months)
  return d.toISOString().split('T')[0]
}
function proximoVencimento(data, recorrencia) {
  if (recorrencia === 'semanal')   return addDays(data, 7)
  if (recorrencia === 'quinzenal') return addDays(data, 15)
  if (recorrencia === 'mensal')    return addMonths(data, 1)
  return null
}
function isAtrasado(dataVencimento, status) {
  if (status !== 'pendente') return false
  return new Date(dataVencimento) < new Date(new Date().toISOString().split('T')[0])
}

const emptyForm = {
  destinatario_tipo: 'fornecedor',
  empresa_id: '',
  destinatario_nome: '',
  forma_pagamento: 'pix_chave',
  pix_tipo_chave: 'CPF',
  pix_chave: '',
  pix_copia_cola: '',
  banco: '',
  valor: '',
  descricao: '',
  data_vencimento: new Date().toISOString().split('T')[0],
  recorrencia: 'unico',
  observacoes: '',
}

// ─── Helper: chama edge function ─────────────────────────────────────────────
async function callPayPix(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/pay-pix-out`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(payload),
  })
  return res.json()
}

// ─── Modal: Pagar via Chave PIX ──────────────────────────────────────────────
function ModalPagarChave({ onClose, onSuccess }) {
  const [form, setForm] = useState({ nome: '', tipoChave: 'CPF', chave: '', valor: '', desc: '' })
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState(null)

  function setF(k, v) { setForm(p => ({ ...p, [k]: v })) }

  async function pagar() {
    if (!form.chave.trim())       { setResult({ ok: false, msg: 'Informe a chave PIX.' }); return }
    if (!form.valor || Number(form.valor) <= 0) { setResult({ ok: false, msg: 'Informe o valor.' }); return }
    setLoading(true); setResult(null)
    const data = await callPayPix({
      direct: true,
      forma: 'pix_chave',
      pix_tipo_chave: form.tipoChave,
      pix_chave: form.chave,
      valor: Number(form.valor),
      destinatario_nome: form.nome,
      descricao: form.desc,
    })
    setLoading(false)
    setResult(data.ok ? { ok: true, msg: `Enviado! Transfer ID: ${data.transfer_id}` } : { ok: false, msg: data.error })
    if (data.ok) onSuccess()
  }

  return (
    <div className="pp-modal-overlay" onClick={() => !loading && onClose()}>
      <div className="pp-modal pag-direct-modal" onClick={e => e.stopPropagation()}>
        <p className="pp-modal-titulo">💸 Pagar via Chave PIX</p>

        <div className="pp-modal-field">
          <label className="pp-modal-label">Nome do destinatário</label>
          <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
            value={form.nome} onChange={e => setF('nome', e.target.value)}
            placeholder="Ex: Alexandre, Fornecedor ABC..." />
        </div>

        <div className="pp-modal-field">
          <label className="pp-modal-label">Tipo de chave</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
            {TIPO_CHAVES.map(t => (
              <button key={t} type="button"
                className={`loja-pay-opt${form.tipoChave === t ? ' active' : ''}`}
                style={{ fontSize: 12, padding: '7px 4px' }}
                onClick={() => setF('tipoChave', t)}>
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="pp-modal-field">
          <label className="pp-modal-label">Chave PIX *</label>
          <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
            value={form.chave} onChange={e => setF('chave', e.target.value)}
            placeholder={
              form.tipoChave === 'CPF' ? '000.000.000-00' :
              form.tipoChave === 'CNPJ' ? '00.000.000/0000-00' :
              form.tipoChave === 'E-mail' ? 'email@exemplo.com' :
              form.tipoChave === 'Telefone' ? '+5511999999999' :
              'Chave aleatória (UUID)'
            } />
        </div>

        <div className="pp-modal-field">
          <label className="pp-modal-label">Valor (R$) *</label>
          <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
            type="number" step="0.01" min="0.01"
            value={form.valor} onChange={e => setF('valor', e.target.value)}
            placeholder="0,00" />
        </div>

        <div className="pp-modal-field">
          <label className="pp-modal-label">Descrição (opcional)</label>
          <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
            value={form.desc} onChange={e => setF('desc', e.target.value)}
            placeholder="Ex: Compra de estoque, comissão..." />
        </div>

        {result && (
          <div className={`pag-result ${result.ok ? 'pag-result-ok' : 'pag-result-err'}`}>
            {result.ok ? '✅ ' : '❌ '}{result.msg}
          </div>
        )}

        <p className="pag-confirm-aviso" style={{ marginTop: 12 }}>
          ⚠️ Pagamento real via PIX debitado da sua conta Efí.
        </p>

        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-btn-secondary" onClick={onClose} disabled={loading}>
            {result?.ok ? 'Fechar' : 'Cancelar'}
          </button>
          {!result?.ok && (
            <button type="button" className="btn pag-pagar-btn" onClick={pagar} disabled={loading} style={{ minWidth: 150 }}>
              {loading ? 'Enviando...' : '💸 Pagar agora'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Modal: Pagar via Copia e Cola ───────────────────────────────────────────
function ModalPagarCola({ onClose, onSuccess }) {
  const [form, setForm] = useState({ nome: '', codigo: '', valor: '', desc: '' })
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState(null)

  function setF(k, v) { setForm(p => ({ ...p, [k]: v })) }

  // Tenta extrair valor do código EMV ao colar
  function onCodigo(v) {
    setF('codigo', v)
    if (v.length > 10 && !form.valor) {
      // Parse simples: campo 54 = valor
      try {
        let pos = 0
        while (pos + 4 <= v.length) {
          const id = v.substring(pos, pos + 2)
          const len = parseInt(v.substring(pos + 2, pos + 4), 10)
          if (isNaN(len)) break
          const val = v.substring(pos + 4, pos + 4 + len)
          if (id === '54') { setF('valor', val); break }
          pos += 4 + len
        }
      } catch { /* silencioso */ }
    }
  }

  async function pagar() {
    if (!form.codigo.trim())      { setResult({ ok: false, msg: 'Cole o código PIX.' }); return }
    if (!form.valor || Number(form.valor) <= 0) { setResult({ ok: false, msg: 'Informe o valor.' }); return }
    setLoading(true); setResult(null)
    const data = await callPayPix({
      direct: true,
      forma: 'pix_copia_cola',
      pix_copia_cola: form.codigo,
      valor: Number(form.valor),
      destinatario_nome: form.nome,
      descricao: form.desc,
    })
    setLoading(false)
    setResult(data.ok ? { ok: true, msg: `Enviado! Transfer ID: ${data.transfer_id}` } : { ok: false, msg: data.error })
    if (data.ok) onSuccess()
  }

  return (
    <div className="pp-modal-overlay" onClick={() => !loading && onClose()}>
      <div className="pp-modal pag-direct-modal" onClick={e => e.stopPropagation()}>
        <p className="pp-modal-titulo">💸 Pagar via Copia e Cola</p>

        <div className="pp-modal-field">
          <label className="pp-modal-label">Código PIX (Copia e Cola) *</label>
          <textarea className="pp-modal-textarea" rows={4}
            value={form.codigo} onChange={e => onCodigo(e.target.value)}
            placeholder="Cole o código PIX aqui — o valor é detectado automaticamente" />
        </div>

        <div className="pp-modal-field">
          <label className="pp-modal-label">Valor (R$) *</label>
          <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
            type="number" step="0.01" min="0.01"
            value={form.valor} onChange={e => setF('valor', e.target.value)}
            placeholder="Detectado automaticamente ou digite" />
        </div>

        <div className="pp-modal-field">
          <label className="pp-modal-label">Nome do destinatário (opcional)</label>
          <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
            value={form.nome} onChange={e => setF('nome', e.target.value)}
            placeholder="Para identificar no histórico" />
        </div>

        <div className="pp-modal-field">
          <label className="pp-modal-label">Descrição (opcional)</label>
          <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
            value={form.desc} onChange={e => setF('desc', e.target.value)}
            placeholder="Ex: Compra de estoque..." />
        </div>

        {result && (
          <div className={`pag-result ${result.ok ? 'pag-result-ok' : 'pag-result-err'}`}>
            {result.ok ? '✅ ' : '❌ '}{result.msg}
          </div>
        )}

        <p className="pag-confirm-aviso" style={{ marginTop: 12 }}>
          ⚠️ Pagamento real via PIX debitado da sua conta Efí.
        </p>

        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-btn-secondary" onClick={onClose} disabled={loading}>
            {result?.ok ? 'Fechar' : 'Cancelar'}
          </button>
          {!result?.ok && (
            <button type="button" className="btn pag-pagar-btn" onClick={pagar} disabled={loading} style={{ minWidth: 150 }}>
              {loading ? 'Enviando...' : '💸 Pagar agora'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────────────────
export default function SuperAdminPagamentos() {
  const [pagamentos, setPagamentos] = useState([])
  const [empresas,   setEmpresas]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [aba,        setAba]        = useState('pendente')

  const [showAgendar,  setShowAgendar]  = useState(false)
  const [showChave,    setShowChave]    = useState(false)
  const [showCola,     setShowCola]     = useState(false)

  const [form,      setForm]      = useState(emptyForm)
  const [salvando,  setSalvando]  = useState(false)
  const [erro,      setErro]      = useState(null)
  const [copiado,   setCopiado]   = useState(null)
  const [marcandoPago, setMarcandoPago] = useState(null)
  const [pagandoId, setPagandoId] = useState(null) // para "Pagar agendado"

  async function load() {
    setLoading(true)
    const [pagRes, empRes] = await Promise.all([
      supabase.from('pagamentos_saas').select('*').order('data_vencimento'),
      supabase.from('empresas').select('id, nome').order('nome'),
    ])
    const pags = (pagRes.data ?? []).map(p => ({
      ...p,
      status: isAtrasado(p.data_vencimento, p.status) ? 'atrasado' : p.status,
    }))
    setPagamentos(pags)
    setEmpresas(empRes.data ?? [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const pendentes = pagamentos.filter(p => p.status === 'pendente' || p.status === 'atrasado')
  const pagos     = pagamentos.filter(p => p.status === 'pago')
  const lista     = aba === 'pendente' ? pendentes : aba === 'pago' ? pagos : pagamentos

  const totalPendente = pendentes.reduce((s, p) => s + Number(p.valor), 0)
  const totalAtrasado = pagamentos.filter(p => p.status === 'atrasado').reduce((s, p) => s + Number(p.valor), 0)
  const totalPagoMes  = pagos.filter(p => {
    const d = new Date(p.pago_em); const n = new Date()
    return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear()
  }).reduce((s, p) => s + Number(p.valor), 0)

  function setF(k, v) { setForm(p => ({ ...p, [k]: v })) }

  async function handleSalvar() {
    if (!form.destinatario_nome.trim()) { setErro('Informe o destinatário.'); return }
    if (!form.valor || Number(form.valor) <= 0) { setErro('Informe um valor válido.'); return }
    if (!form.data_vencimento) { setErro('Informe a data de vencimento.'); return }
    setErro(null); setSalvando(true)

    const payload = {
      destinatario_tipo: form.destinatario_tipo,
      empresa_id: form.destinatario_tipo === 'loja' && form.empresa_id ? form.empresa_id : null,
      destinatario_nome: form.destinatario_nome.trim(),
      forma_pagamento: form.forma_pagamento,
      pix_tipo_chave: form.forma_pagamento === 'pix_chave' ? form.pix_tipo_chave : null,
      pix_chave: form.forma_pagamento === 'pix_chave' ? form.pix_chave.trim() : null,
      pix_copia_cola: form.forma_pagamento === 'pix_copia_cola' ? form.pix_copia_cola.trim() : null,
      banco: ['boleto', 'transferencia'].includes(form.forma_pagamento) ? form.banco.trim() : null,
      valor: Number(form.valor),
      descricao: form.descricao.trim() || null,
      data_vencimento: form.data_vencimento,
      recorrencia: form.recorrencia,
      observacoes: form.observacoes.trim() || null,
      status: 'pendente',
    }

    const { error } = await supabase.from('pagamentos_saas').insert(payload)
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setShowAgendar(false); setForm(emptyForm); load()
  }

  async function handleMarcarPago(pag) {
    setMarcandoPago(pag.id)
    const now = new Date().toISOString()
    await supabase.from('pagamentos_saas').update({ status: 'pago', pago_em: now }).eq('id', pag.id)
    if (pag.recorrencia !== 'unico') {
      const proxData = proximoVencimento(pag.data_vencimento, pag.recorrencia)
      if (proxData) {
        await supabase.from('pagamentos_saas').insert({
          destinatario_tipo: pag.destinatario_tipo, empresa_id: pag.empresa_id,
          destinatario_nome: pag.destinatario_nome, forma_pagamento: pag.forma_pagamento,
          pix_tipo_chave: pag.pix_tipo_chave, pix_chave: pag.pix_chave,
          pix_copia_cola: pag.pix_copia_cola, banco: pag.banco,
          valor: pag.valor, descricao: pag.descricao,
          data_vencimento: proxData, recorrencia: pag.recorrencia,
          observacoes: pag.observacoes, status: 'pendente', origem_id: pag.id,
        })
      }
    }
    setMarcandoPago(null); load()
  }

  async function handlePagarAgendado(pag) {
    if (!confirm(`Pagar ${fmt(pag.valor)} para ${pag.destinatario_nome} via PIX (Efí) agora?`)) return
    setPagandoId(pag.id)
    const data = await callPayPix({ pagamento_id: pag.id })
    setPagandoId(null)
    if (data.ok) {
      alert(`✅ Pago! Transfer ID: ${data.transfer_id}`)
      load()
    } else {
      alert(`❌ Erro: ${data.error}`)
    }
  }

  async function handleCancelar(id) {
    if (!confirm('Cancelar este pagamento?')) return
    await supabase.from('pagamentos_saas').update({ status: 'cancelado' }).eq('id', id)
    load()
  }

  function copiar(texto, id) {
    navigator.clipboard.writeText(texto).then(() => {
      setCopiado(id); setTimeout(() => setCopiado(null), 2500)
    })
  }

  if (loading) return <div className="page-loading">Carregando...</div>

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header pag-header">
        <h1 className="page-title">Pagamentos</h1>
        <div className="pag-header-acoes">
          <button className="btn pag-pagar-btn" onClick={() => setShowCola(true)}>
            💸 Copia e Cola
          </button>
          <button className="btn pag-pagar-btn" onClick={() => setShowChave(true)}>
            💸 Chave PIX
          </button>
          <button className="btn btn-secondary" onClick={() => { setShowAgendar(true); setErro(null); setForm(emptyForm) }}>
            📅 Agendar
          </button>
        </div>
      </div>

      {/* Cards resumo */}
      <div className="pag-cards">
        <div className="pag-card">
          <span className="pag-card-label">A pagar</span>
          <span className="pag-card-valor" style={{ color: '#ca8a04' }}>{fmt(totalPendente)}</span>
          <span className="pag-card-sub">{pendentes.length} pagamento{pendentes.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="pag-card">
          <span className="pag-card-label">Atrasado</span>
          <span className="pag-card-valor" style={{ color: '#dc2626' }}>{fmt(totalAtrasado)}</span>
          <span className="pag-card-sub">{pagamentos.filter(p => p.status === 'atrasado').length} em atraso</span>
        </div>
        <div className="pag-card">
          <span className="pag-card-label">Pago este mês</span>
          <span className="pag-card-valor" style={{ color: '#16a34a' }}>{fmt(totalPagoMes)}</span>
          <span className="pag-card-sub">{pagos.filter(p => { const d = new Date(p.pago_em); const n = new Date(); return d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear() }).length} pagamento{pagos.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Abas */}
      <div className="pag-abas">
        {[['pendente', `A pagar (${pendentes.length})`], ['pago', `Histórico (${pagos.length})`], ['todos', 'Todos']].map(([v, l]) => (
          <button key={v} className={`pag-aba${aba === v ? ' active' : ''}`} onClick={() => setAba(v)}>{l}</button>
        ))}
      </div>

      {/* Lista */}
      {lista.length === 0 ? (
        <div className="pag-empty">
          <p>Nenhum pagamento aqui.</p>
          <button className="btn btn-secondary" onClick={() => { setShowAgendar(true); setErro(null); setForm(emptyForm) }}>📅 Agendar pagamento</button>
        </div>
      ) : (
        <div className="pag-lista">
          {lista.map(pag => {
            const st   = STATUS_STYLE[pag.status] ?? STATUS_STYLE.pendente
            const ativo = pag.status === 'pendente' || pag.status === 'atrasado'
            const isPix = pag.forma_pagamento === 'pix_chave' || pag.forma_pagamento === 'pix_copia_cola'
            return (
              <div key={pag.id} className="pag-item">
                <div className="pag-item-top">
                  <div>
                    <span className="pag-item-nome">{pag.destinatario_nome}</span>
                    <span className="pag-item-tipo">{pag.destinatario_tipo === 'loja' ? '🏪 Loja' : '📦 Fornecedor'}</span>
                  </div>
                  <span className="pag-item-valor">{fmt(pag.valor)}</span>
                </div>

                <div className="pag-item-mid">
                  <span className="pag-badge" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                  <span className="pag-item-data">
                    📅 {new Date(pag.data_vencimento + 'T12:00:00').toLocaleDateString('pt-BR')}
                    {pag.recorrencia !== 'unico' && ` · ${RECORRENCIAS.find(r => r.value === pag.recorrencia)?.label}`}
                  </span>
                  <span className="pag-item-forma">{FORMA_LABEL[pag.forma_pagamento]}</span>
                </div>

                {pag.descricao && <p className="pag-item-desc">{pag.descricao}</p>}

                {pag.forma_pagamento === 'pix_chave' && pag.pix_chave && (
                  <div className="pag-pix-row">
                    <span className="pag-pix-label">{pag.pix_tipo_chave}:</span>
                    <span className="pag-pix-chave">{pag.pix_chave}</span>
                    <button className="pag-copy-btn" onClick={() => copiar(pag.pix_chave, pag.id + '_chave')}>
                      {copiado === pag.id + '_chave' ? '✓ Copiado' : 'Copiar'}
                    </button>
                  </div>
                )}
                {pag.forma_pagamento === 'pix_copia_cola' && pag.pix_copia_cola && (
                  <div className="pag-pix-row">
                    <span className="pag-pix-label">Cód:</span>
                    <span className="pag-pix-chave">{pag.pix_copia_cola.slice(0, 40)}…</span>
                    <button className="pag-copy-btn" onClick={() => copiar(pag.pix_copia_cola, pag.id + '_cola')}>
                      {copiado === pag.id + '_cola' ? '✓ Copiado' : 'Copiar código'}
                    </button>
                  </div>
                )}
                {pag.banco && (
                  <div className="pag-pix-row">
                    <span className="pag-pix-label">Banco:</span>
                    <span className="pag-pix-chave">{pag.banco}</span>
                  </div>
                )}

                {pag.pago_em && (
                  <p className="pag-item-pago-em">Pago em {new Date(pag.pago_em).toLocaleString('pt-BR')}</p>
                )}

                {ativo && (
                  <div className="pag-item-acoes">
                    {isPix && (
                      <button
                        className="btn btn-sm pag-pagar-btn"
                        onClick={() => handlePagarAgendado(pag)}
                        disabled={pagandoId === pag.id}
                      >
                        {pagandoId === pag.id ? 'Enviando...' : '💸 Pagar agora'}
                      </button>
                    )}
                    <button className="btn btn-secondary btn-sm"
                      onClick={() => handleMarcarPago(pag)} disabled={marcandoPago === pag.id}>
                      {marcandoPago === pag.id ? 'Salvando...' : '✓ Marcar como pago'}
                    </button>
                    <button className="btn btn-secondary btn-sm" style={{ color: 'var(--danger)' }}
                      onClick={() => handleCancelar(pag.id)}>
                      Cancelar
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Modais de pagamento direto */}
      {showChave && (
        <ModalPagarChave
          onClose={() => setShowChave(false)}
          onSuccess={() => { setShowChave(false); load() }}
        />
      )}
      {showCola && (
        <ModalPagarCola
          onClose={() => setShowCola(false)}
          onSuccess={() => { setShowCola(false); load() }}
        />
      )}

      {/* Modal agendar pagamento */}
      {showAgendar && (
        <div className="pp-modal-overlay" onClick={() => setShowAgendar(false)}>
          <div className="pp-modal" style={{ maxWidth: 500, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <p className="pp-modal-titulo">📅 Agendar pagamento</p>

            <div className="pp-modal-field">
              <label className="pp-modal-label">Tipo</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['loja', 'fornecedor'].map(t => (
                  <button key={t} type="button"
                    className={`loja-pay-opt${form.destinatario_tipo === t ? ' active' : ''}`}
                    onClick={() => setF('destinatario_tipo', t)} style={{ flex: 1 }}>
                    {t === 'loja' ? '🏪 Loja parceira' : '📦 Fornecedor'}
                  </button>
                ))}
              </div>
            </div>

            {form.destinatario_tipo === 'loja' && (
              <div className="pp-modal-field">
                <label className="pp-modal-label">Loja</label>
                <select className="pp-modal-textarea" style={{ height: 42, padding: '0 10px' }}
                  value={form.empresa_id}
                  onChange={e => {
                    const emp = empresas.find(em => em.id === e.target.value)
                    setF('empresa_id', e.target.value)
                    if (emp) setF('destinatario_nome', emp.nome)
                  }}>
                  <option value="">Selecionar loja...</option>
                  {empresas.map(e => <option key={e.id} value={e.id}>{e.nome}</option>)}
                </select>
              </div>
            )}

            <div className="pp-modal-field">
              <label className="pp-modal-label">Nome do destinatário *</label>
              <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
                value={form.destinatario_nome} onChange={e => setF('destinatario_nome', e.target.value)}
                placeholder="Nome da empresa ou pessoa" />
            </div>

            <div className="pp-modal-field">
              <label className="pp-modal-label">Forma de pagamento</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {FORMAS.map(f => (
                  <button key={f.value} type="button"
                    className={`loja-pay-opt${form.forma_pagamento === f.value ? ' active' : ''}`}
                    onClick={() => setF('forma_pagamento', f.value)}>{f.label}</button>
                ))}
              </div>
            </div>

            {form.forma_pagamento === 'pix_chave' && (
              <>
                <div className="pp-modal-field">
                  <label className="pp-modal-label">Tipo de chave</label>
                  <select className="pp-modal-textarea" style={{ height: 42, padding: '0 10px' }}
                    value={form.pix_tipo_chave} onChange={e => setF('pix_tipo_chave', e.target.value)}>
                    {TIPO_CHAVES.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div className="pp-modal-field">
                  <label className="pp-modal-label">Chave PIX *</label>
                  <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
                    value={form.pix_chave} onChange={e => setF('pix_chave', e.target.value)}
                    placeholder="Digite a chave PIX" />
                </div>
              </>
            )}
            {form.forma_pagamento === 'pix_copia_cola' && (
              <div className="pp-modal-field">
                <label className="pp-modal-label">Código PIX (Copia e Cola) *</label>
                <textarea className="pp-modal-textarea" rows={3}
                  value={form.pix_copia_cola} onChange={e => setF('pix_copia_cola', e.target.value)}
                  placeholder="Cole o código PIX aqui" />
              </div>
            )}
            {['boleto', 'transferencia'].includes(form.forma_pagamento) && (
              <div className="pp-modal-field">
                <label className="pp-modal-label">Banco / Informações</label>
                <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
                  value={form.banco} onChange={e => setF('banco', e.target.value)}
                  placeholder="Ex: Banco do Brasil, ag. 1234-5, cc 12345-6" />
              </div>
            )}

            <div className="pp-modal-field">
              <label className="pp-modal-label">Valor (R$) *</label>
              <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
                type="number" step="0.01" min="0.01"
                value={form.valor} onChange={e => setF('valor', e.target.value)}
                placeholder="0,00" />
            </div>
            <div className="pp-modal-field">
              <label className="pp-modal-label">Descrição</label>
              <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
                value={form.descricao} onChange={e => setF('descricao', e.target.value)}
                placeholder="Ex: Comissão semana 23, Compra de estoque..." />
            </div>
            <div className="pp-modal-field">
              <label className="pp-modal-label">Data de vencimento *</label>
              <input className="pp-modal-textarea" style={{ height: 40, padding: '0 10px' }}
                type="date" value={form.data_vencimento}
                onChange={e => setF('data_vencimento', e.target.value)} />
            </div>
            <div className="pp-modal-field">
              <label className="pp-modal-label">Recorrência</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {RECORRENCIAS.map(r => (
                  <button key={r.value} type="button"
                    className={`loja-pay-opt${form.recorrencia === r.value ? ' active' : ''}`}
                    onClick={() => setF('recorrencia', r.value)}>{r.label}</button>
                ))}
              </div>
            </div>
            <div className="pp-modal-field">
              <label className="pp-modal-label">Observações</label>
              <textarea className="pp-modal-textarea" rows={2}
                value={form.observacoes} onChange={e => setF('observacoes', e.target.value)}
                placeholder="Notas internas..." />
            </div>

            {erro && <p style={{ color: '#ef4444', fontSize: 13, margin: '0 0 12px' }}>{erro}</p>}

            <div className="pp-modal-actions">
              <button type="button" className="pp-modal-btn-secondary" onClick={() => setShowAgendar(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={handleSalvar} disabled={salvando}>
                {salvando ? 'Salvando...' : '📅 Salvar agendamento'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
