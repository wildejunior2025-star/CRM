import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import './PortalLoja.css'

export default function PortalPerfil() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError]     = useState(null)
  const [email, setEmail]     = useState('')
  const [form, setForm]       = useState({ nome: '', telefone: '' })

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoading(false); return }
      setEmail(user.email ?? '')

      const [{ data: cliente }, { data: profile }] = await Promise.all([
        supabase.from('clientes').select('nome, telefone').eq('user_id', user.id).maybeSingle(),
        supabase.from('profiles').select('nome, telefone').eq('id', user.id).maybeSingle(),
      ])

      setForm({
        nome:     cliente?.nome     || profile?.nome     || user.user_metadata?.nome || '',
        telefone: cliente?.telefone || profile?.telefone || '',
      })
      setLoading(false)
    }
    load()
  }, [])

  function set(field) {
    return e => {
      setForm(p => ({ ...p, [field]: e.target.value }))
      setSuccess(false)
      setError(null)
    }
  }

  async function handleSalvar(e) {
    e.preventDefault()
    if (!form.nome.trim()) { setError('Nome é obrigatório.'); return }
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.rpc('update_perfil_cliente', {
      p_nome:        form.nome.trim(),
      p_telefone:    form.telefone.trim(),
      p_cep:         '',
      p_endereco:    '',
      p_numero:      '',
      p_complemento: '',
      p_bairro:      '',
      p_cidade:      '',
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    setSuccess(true)
    setTimeout(() => setSuccess(false), 3000)
  }

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
      <div className="loja-spinner" />
    </div>
  )

  return (
    <div style={{ maxWidth: 540, margin: '0 auto', padding: '24px 16px 100px' }}>
      <h2 style={{ margin: '0 0 20px', fontSize: 18, fontWeight: 700 }}>Meu Perfil</h2>

      <form onSubmit={handleSalvar} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="loja-checkout-section">
          <h3>Dados pessoais</h3>

          <div className="loja-checkout-field full">
            <label>Nome <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input type="text" value={form.nome} onChange={set('nome')}
              placeholder="Seu nome completo" autoComplete="name" />
          </div>

          <div className="loja-checkout-field full">
            <label>E-mail</label>
            <input type="email" value={email} disabled
              style={{ opacity: 0.6, cursor: 'not-allowed' }} />
          </div>

          <div className="loja-checkout-field full">
            <label>WhatsApp / Telefone</label>
            <input type="tel" value={form.telefone} onChange={set('telefone')}
              placeholder="(84) 99999-9999" autoComplete="tel" />
          </div>
        </div>

        {error && <div className="loja-erro">{error}</div>}

        {success && (
          <div style={{
            padding: '12px 16px', background: 'var(--success-bg)', color: 'var(--success)',
            borderRadius: 8, fontWeight: 600, fontSize: 14,
          }}>
            Perfil salvo com sucesso!
          </div>
        )}

        <button type="submit" className="loja-btn-confirmar"
          disabled={saving} style={{ margin: 0, width: '100%' }}>
          {saving ? <><span className="loja-btn-spinner" /> Salvando...</> : 'Salvar perfil'}
        </button>
      </form>

      {/* Informações legais */}
      <div style={{ marginTop: 36, borderTop: '1px solid var(--border)', paddingTop: 24 }}>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
          Informações legais
        </p>
        <Link to="/termos" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', borderRadius: 10,
          background: 'var(--card-bg)', border: '1px solid var(--border)',
          textDecoration: 'none', color: 'var(--text)', marginBottom: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 20 }}>📄</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Termos de Uso</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Regras de uso da plataforma</div>
            </div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </Link>
        <Link to="/privacidade" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', borderRadius: 10,
          background: 'var(--card-bg)', border: '1px solid var(--border)',
          textDecoration: 'none', color: 'var(--text)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 20 }}>🔒</span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Política de Privacidade</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Como usamos seus dados</div>
            </div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </Link>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', marginTop: 20 }}>
          FWC Inter · FWC INTERMEDIAÇÕES LTDA · CNPJ 66.437.917/0001-66
        </p>
      </div>
    </div>
  )
}
