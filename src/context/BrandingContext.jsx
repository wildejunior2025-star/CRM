import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

const BrandingCtx = createContext({ empresaParceira: null, loadingBranding: false, plataformaLogoUrl: null })

const MAIN_HOSTS = ['app.fwcinter.com', 'portal.fwcinter.com', 'admin.fwcinter.com', 'fwcinter.com', 'crm.wildejunior2025.workers.dev', 'localhost', '127.0.0.1']

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  }
}

function darken(hex, pct = 0.12) {
  const { r, g, b } = hexToRgb(hex)
  const f = 1 - pct
  return '#' + [r, g, b].map(v => Math.round(v * f).toString(16).padStart(2, '0')).join('')
}

function applyBranding(cor) {
  if (!cor || !/#[0-9a-fA-F]{6}/.test(cor)) return
  const { r, g, b } = hexToRgb(cor)
  const root = document.documentElement
  root.style.setProperty('--primary',      cor)
  root.style.setProperty('--primary-hover', darken(cor, 0.12))
  root.style.setProperty('--primary-bg',   `rgba(${r},${g},${b},0.12)`)
  root.style.setProperty('--primary-ring',  `rgba(${r},${g},${b},0.35)`)
}

export function BrandingProvider({ children }) {
  const [empresaParceira, setEmpresaParceira] = useState(null)
  const [loadingBranding, setLoadingBranding] = useState(true)
  const [plataformaLogoUrl, setPlataformaLogoUrl] = useState(null)

  // Carrega logo da plataforma (sempre, independente do domínio)
  useEffect(() => {
    supabase
      .from('configuracoes_plataforma')
      .select('valor')
      .eq('chave', 'logo_url')
      .maybeSingle()
      .then(({ data }) => {
        if (data?.valor) setPlataformaLogoUrl(data.valor)
      })
  }, [])

  useEffect(() => {
    const hostname = window.location.hostname
    if (MAIN_HOSTS.some(h => hostname === h || hostname.endsWith(h))) {
      setLoadingBranding(false)
      return
    }

    supabase
      .rpc('get_branding_by_domain', { p_hostname: hostname })
      .then(({ data }) => {
        const emp = Array.isArray(data) ? data[0] : data
        if (emp) {
          setEmpresaParceira(emp)
          applyBranding(emp.cor_primaria)
        }
        setLoadingBranding(false)
      })
  }, [])

  return (
    <BrandingCtx.Provider value={{ empresaParceira, loadingBranding, plataformaLogoUrl }}>
      {children}
    </BrandingCtx.Provider>
  )
}

export function useBranding() {
  return useContext(BrandingCtx)
}
