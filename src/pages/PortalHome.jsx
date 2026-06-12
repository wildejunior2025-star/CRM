import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useBranding } from '../context/BrandingContext'
import './PortalHome.css'

function IconLoja() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  )
}

function IconSeta() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6"/>
    </svg>
  )
}

export default function PortalHome() {
  const [empresas, setEmpresas] = useState([])
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')
  const navigate = useNavigate()
  const { empresaParceira, loadingBranding } = useBranding()

  // Domínio exclusivo de uma loja → vai direto pro catálogo dela
  if (!loadingBranding && empresaParceira) {
    return <Navigate to={`/portal/loja/${empresaParceira.id}`} replace />
  }

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('empresas')
        .select('id, nome, email_contato, status, created_at, banner_url, logo_url, descricao')
        .in('status', ['trial', 'ativo', 'atrasado'])
        .order('nome')
      setEmpresas(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  const filtradas = busca.trim()
    ? empresas.filter(e => e.nome.toLowerCase().includes(busca.trim().toLowerCase()))
    : empresas

  if (loading) {
    return (
      <div className="home-loading">
        <div className="home-spinner" />
        <p>Buscando lojas...</p>
      </div>
    )
  }

  return (
    <div className="home-root">
      {/* Busca */}
      <div className="home-search-wrap">
        <svg className="home-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          className="home-search"
          placeholder="Buscar loja..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
        />
      </div>

      {filtradas.length === 0 ? (
        <div className="home-empty">
          <p>Nenhuma loja encontrada.</p>
        </div>
      ) : (
        <div className="home-lista">
          {filtradas.map(emp => (
            <button key={emp.id} className="home-loja-card" onClick={() => navigate(`/portal/loja/${emp.id}`)}>
              <div className="home-loja-banner">
                {emp.banner_url
                  ? <img src={emp.banner_url} alt="" />
                  : <div className="home-loja-banner-placeholder" />
                }
                <div className="home-loja-logo-wrap">
                  {emp.logo_url
                    ? <img src={emp.logo_url} alt={emp.nome} className="home-loja-logo-img" />
                    : <div className="home-loja-logo-placeholder"><IconLoja /></div>
                  }
                </div>
              </div>
              <div className="home-loja-info">
                <span className="home-loja-nome">{emp.nome}</span>
                {emp.descricao && <span className="home-loja-descricao">{emp.descricao}</span>}
              </div>
              <div className="home-loja-arrow"><IconSeta /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
