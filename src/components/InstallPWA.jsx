import { useEffect, useState } from 'react'
import './InstallPWA.css'

export default function InstallPWA() {
  const [prompt, setPrompt] = useState(null)
  const [shown, setShown] = useState(false)
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('pwa-dismissed') === '1'
  )

  useEffect(() => {
    function handler(e) {
      e.preventDefault()
      setPrompt(e)
      setShown(true)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function handleInstall() {
    if (!prompt) return
    prompt.prompt()
    const { outcome } = await prompt.userChoice
    if (outcome === 'accepted') setShown(false)
    setPrompt(null)
  }

  function handleDismiss() {
    setDismissed(true)
    localStorage.setItem('pwa-dismissed', '1')
  }

  if (!shown || dismissed) return null

  return (
    <div className="install-pwa-banner">
      <div className="install-pwa-content">
        <div className="install-pwa-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v13M5 15l7 7 7-7" />
            <path d="M3 21h18" />
          </svg>
        </div>
        <div className="install-pwa-text">
          <strong>Instalar app</strong>
          <span>Acesse o CRM direto da tela inicial do celular</span>
        </div>
      </div>
      <div className="install-pwa-actions">
        <button className="btn btn-primary btn-sm" onClick={handleInstall}>
          Instalar
        </button>
        <button className="btn btn-secondary btn-sm" onClick={handleDismiss}>
          Agora não
        </button>
      </div>
    </div>
  )
}
