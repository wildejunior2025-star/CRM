import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'

// Tela do super admin no gestor: lista todas as lojas e entra na escolhida
// (mesmo mecanismo do "Acessar" em Super Admin > Empresas), caindo direto no /painel.
export default function EscolherLoja() {
  const { logout } = useAuth()
  const [empresas, setEmpresas] = useState([])
  const [busca, setBusca] = useState('')
  const [carregando, setCarregando] = useState(true)
  const [entrandoId, setEntrandoId] = useState(null)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    supabase.from('empresas').select('id, nome, status, logo_url').order('nome').then(({ data, error }) => {
      if (error) setErro(error.message)
      setEmpresas(data ?? [])
      setCarregando(false)
    })
  }, [])

  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase()
    return q ? empresas.filter(e => (e.nome ?? '').toLowerCase().includes(q)) : empresas
  }, [empresas, busca])

  async function entrar(emp) {
    setEntrandoId(emp.id)
    setErro(null)

    // O magic link sobrescreve a sessão: guarda a do super admin pra poder voltar.
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      localStorage.setItem('crm_superadmin_backup', JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      }))
    }
    localStorage.setItem('crm_superadmin_cliente_nome', emp.nome || 'empresa')

    const { data, error } = await supabase.functions.invoke('impersonate-empresa', {
      body: { empresa_id: emp.id, redirect_to: window.location.origin },
    })
    if (error || !data?.link) {
      localStorage.removeItem('crm_superadmin_backup')
      setErro(error?.message ?? data?.error ?? 'Erro ao gerar link de acesso')
      setEntrandoId(null)
      return
    }

    let tokenHash = null
    try { tokenHash = new URL(data.link).searchParams.get('token') } catch { /* link inesperado */ }
    if (tokenHash) {
      const { error: vErr } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash })
      if (!vErr) { window.location.href = '/painel'; return }
    }
    window.location.href = data.link
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)', padding: '24px 16px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Escolha a loja</h1>
          <button type="button" onClick={logout}
            style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer' }}>
            Sair
          </button>
        </div>
        <input
          type="search" value={busca} onChange={e => setBusca(e.target.value)}
          placeholder="Buscar loja…" autoFocus
          style={{ width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 16, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', marginBottom: 12 }}
        />
        {erro && <p style={{ color: 'var(--danger)' }}>{erro}</p>}
        {carregando && <p style={{ color: 'var(--text-muted)' }}>Carregando lojas…</p>}
        {!carregando && filtradas.length === 0 && <p style={{ color: 'var(--text-muted)' }}>Nenhuma loja encontrada.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtradas.map(e => (
            <button key={e.id} type="button" disabled={!!entrandoId} onClick={() => entrar(e)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left', padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: entrandoId ? 'wait' : 'pointer', opacity: entrandoId && entrandoId !== e.id ? 0.5 : 1 }}>
              {e.logo_url
                ? <img src={e.logo_url} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} />
                : <span style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--primary-bg)', color: 'var(--primary)', display: 'grid', placeItems: 'center', fontWeight: 700 }}>{(e.nome ?? '?')[0]?.toUpperCase()}</span>}
              <span style={{ flex: 1, fontWeight: 600 }}>{e.nome}</span>
              <span style={{ fontSize: 12, color: e.status === 'ativo' ? 'var(--success)' : 'var(--text-muted)' }}>
                {entrandoId === e.id ? 'Entrando…' : e.status}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
