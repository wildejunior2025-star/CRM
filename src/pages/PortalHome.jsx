import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useBranding } from '../context/BrandingContext'
import './PortalHome.css'

function IconLoja({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/>
      <line x1="3" y1="6" x2="21" y2="6"/>
      <path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  )
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
    </svg>
  )
}

function StatusPill({ status }) {
  const map = {
    ativo:    { label: 'Aberto',   cls: 'pill-open' },
    trial:    { label: 'Aberto',   cls: 'pill-open' },
    atrasado: { label: 'Atenção',  cls: 'pill-warn' },
  }
  const { label, cls } = map[status] ?? { label: status, cls: '' }
  return <span className={`ph-pill ${cls}`}>{label}</span>
}

function CardSkeleton() {
  return (
    <div className="ph-card ph-card--skeleton" aria-hidden="true">
      <div className="ph-card-logo ph-skeleton-box" />
      <div className="ph-card-body">
        <div className="ph-skeleton-line" style={{ width: '60%', height: 14, marginBottom: 8 }} />
        <div className="ph-skeleton-line" style={{ width: '85%', height: 12, marginBottom: 4 }} />
        <div className="ph-skeleton-line" style={{ width: '50%', height: 12, marginBottom: 12 }} />
        <div className="ph-skeleton-line" style={{ width: 52, height: 18, borderRadius: 99 }} />
      </div>
    </div>
  )
}

export default function PortalHome() {
  const [empresas, setEmpresas] = useState([])
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')
  const navigate = useNavigate()
  const { empresaParceira, loadingBranding } = useBranding()

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

  // Domínio exclusivo de uma loja → vai direto pro catálogo dela
  if (!loadingBranding && empresaParceira) {
    return <Navigate to={`/portal/loja/${empresaParceira.id}`} replace />
  }

  const filtradas = busca.trim()
    ? empresas.filter(e => e.nome.toLowerCase().includes(busca.trim().toLowerCase()))
    : empresas

  return (
    <div className="ph-root">
      {/* Busca */}
      <div className="ph-search-wrap">
        <span className="ph-search-icon"><IconSearch /></span>
        <input
          className="ph-search"
          placeholder="Buscar loja..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
        />
      </div>

      {/* Título */}
      <h2 className="ph-section-title">Lojas</h2>

      {/* Skeletons enquanto carrega */}
      {loading && (
        <div className="ph-grid">
          {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      )}

      {/* Estado vazio */}
      {!loading && filtradas.length === 0 && (
        <div className="ph-empty">
          <span className="ph-empty-icon"><IconLoja size={32} /></span>
          <p className="ph-empty-title">
            {busca.trim() ? 'Nenhuma loja encontrada' : 'Nenhuma loja disponível'}
          </p>
          {busca.trim() && (
            <p className="ph-empty-sub">Tente outro termo de busca.</p>
          )}
        </div>
      )}

      {/* Grid de lojas */}
      {!loading && filtradas.length > 0 && (
        <div className="ph-grid">
          {filtradas.map(emp => (
            <button
              key={emp.id}
              className="ph-card"
              onClick={() => navigate(`/portal/loja/${emp.id}`)}
            >
              {/* Thumbnail quadrada */}
              <div className="ph-card-logo">
                {emp.logo_url
                  ? <img src={emp.logo_url} alt={emp.nome} className="ph-card-logo-img" />
                  : (
                    <div className="ph-card-logo-placeholder">
                      <IconLoja size={28} />
                    </div>
                  )
                }
              </div>

              {/* Informações */}
              <div className="ph-card-body">
                <p className="ph-card-nome">{emp.nome}</p>
                {emp.descricao && (
                  <p className="ph-card-desc">{emp.descricao}</p>
                )}
                <StatusPill status={emp.status} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
