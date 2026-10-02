import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import './DeliveryLojas.css'

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function IconStore() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l1-5h16l1 5" />
      <path d="M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9z" />
      <path d="M9 21V9m6 0v12" />
    </svg>
  )
}

function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

function IconMoto() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="17" r="3" />
      <circle cx="19" cy="17" r="3" />
      <path d="M8 17h8M5 14l2-7h8l3 7" />
      <path d="M13 7l1-4h3" />
    </svg>
  )
}

function CardSkeleton() {
  return (
    <div className="dl-card dl-card--skeleton" aria-hidden="true">
      <div className="dl-card-banner dl-skel" />
      <div className="dl-card-body">
        <div className="dl-skel" style={{ height: 14, width: '65%', marginBottom: 8, borderRadius: 4 }} />
        <div className="dl-skel" style={{ height: 11, width: '40%', marginBottom: 12, borderRadius: 4 }} />
        <div className="dl-skel" style={{ height: 11, width: '80%', borderRadius: 4 }} />
      </div>
    </div>
  )
}

// O que escrever na etiqueta da moto.
//
// `taxa_entrega` é a taxa fixa da loja — mas quem cobra por km ou por bairro
// guarda ali só uma reserva, que o checkout usa quando o cálculo não fecha.
// Mostrar essa reserva como preço fazia a lista prometer barato (e, quando a
// reserva era 0, prometer "Entrega grátis" numa loja que cobra frete).
// Para quem tem faixa, a honesta é a MENOR faixa com um "A partir de" na frente:
// é verdade, continua atraente, e ninguém se sente enganado no checkout.
function rotuloTaxa(loja) {
  const faixas = []
  if (Array.isArray(loja.taxas_entrega_km)) {
    for (const f of loja.taxas_entrega_km) faixas.push(Number(f?.taxa) || 0)
  }
  if (Array.isArray(loja.taxas_entrega_bairro)) {
    // bairro com `entrega: false` é bairro bloqueado, não é taxa.
    for (const b of loja.taxas_entrega_bairro) {
      if (b?.entrega !== false) faixas.push(Number(b?.taxa) || 0)
    }
  }
  const brl = v => `R$ ${v.toFixed(2).replace('.', ',')}`
  if (faixas.length) {
    const menor = Math.min(...faixas)
    return menor === 0 ? 'Grátis perto da loja' : `A partir de ${brl(menor)}`
  }
  if (loja.taxa_entrega == null) return 'Taxa a consultar'
  return Number(loja.taxa_entrega) === 0 ? 'Entrega grátis' : brl(Number(loja.taxa_entrega))
}

export default function DeliveryLojas() {
  const [lojas, setLojas] = useState([])
  const [loading, setLoading] = useState(true)
  const [busca, setBusca] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('empresas')
        .select('id, nome, categoria_delivery, taxa_entrega, taxas_entrega_km, taxas_entrega_bairro, tempo_entrega_min, tempo_entrega_max, delivery_ativo, banner_url, cidade, estado')
        .eq('aceita_delivery', true)
        .in('status', ['trial', 'ativo', 'atrasado'])
        .order('nome')
      setLojas(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  const filtradas = busca.trim()
    ? lojas.filter(l => l.nome.toLowerCase().includes(busca.trim().toLowerCase()))
    : lojas

  return (
    <div className="dl-root">
      <header className="dl-header">
        <div className="dl-header-inner">
          <span className="dl-logo">FWC</span>
          <p className="dl-tagline">Peça de qualquer loja</p>
        </div>
      </header>

      <main className="dl-main">
        <div className="dl-search-wrap">
          <span className="dl-search-icon"><IconSearch /></span>
          <input
            className="dl-search"
            placeholder="Buscar loja..."
            value={busca}
            onChange={e => setBusca(e.target.value)}
          />
        </div>

        <h2 className="dl-section-title">
          {busca.trim() ? `Resultados para "${busca.trim()}"` : 'Lojas disponíveis'}
        </h2>

        {loading && (
          <div className="dl-grid">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        )}

        {!loading && filtradas.length === 0 && (
          <div className="dl-empty">
            <span className="dl-empty-icon"><IconStore /></span>
            <p className="dl-empty-title">
              {busca.trim() ? 'Nenhuma loja encontrada' : 'Nenhuma loja disponível na sua região ainda'}
            </p>
            {busca.trim() && (
              <p className="dl-empty-sub">Tente outro termo de busca.</p>
            )}
          </div>
        )}

        {!loading && filtradas.length > 0 && (
          <div className="dl-grid">
            {filtradas.map(loja => (
              <button
                key={loja.id}
                className="dl-card"
                onClick={() => navigate(`/loja/${loja.id}`)}
              >
                <div className="dl-card-banner">
                  {loja.banner_url
                    ? <img src={loja.banner_url} alt={loja.nome} className="dl-card-banner-img" />
                    : (
                      <div className="dl-card-banner-placeholder">
                        <IconStore />
                      </div>
                    )
                  }
                  <span className={`dl-badge ${loja.delivery_ativo ? 'dl-badge--open' : 'dl-badge--closed'}`}>
                    {loja.delivery_ativo ? 'Aberto' : 'Fechado'}
                  </span>
                </div>

                <div className="dl-card-body">
                  <p className="dl-card-nome">{loja.nome}</p>
                  {loja.categoria_delivery && (
                    <p className="dl-card-cat">{loja.categoria_delivery}</p>
                  )}
                  <div className="dl-card-meta">
                    {(loja.tempo_entrega_min || loja.tempo_entrega_max) && (
                      <span className="dl-meta-item">
                        <IconClock />
                        {loja.tempo_entrega_min && loja.tempo_entrega_max
                          ? `${loja.tempo_entrega_min}–${loja.tempo_entrega_max} min`
                          : loja.tempo_entrega_min
                            ? `A partir de ${loja.tempo_entrega_min} min`
                            : `Até ${loja.tempo_entrega_max} min`
                        }
                      </span>
                    )}
                    <span className="dl-meta-item">
                      <IconMoto />
                      {rotuloTaxa(loja)}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
