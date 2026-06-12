import { useState, useEffect } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

export default function MinhaLoja() {
  const { empresa, refreshProfile } = useAuth()

  const [nome, setNome] = useState('')
  const [descricao, setDescricao] = useState('')
  const [emailContato, setEmailContato] = useState('')
  const [bannerUrl, setBannerUrl] = useState('')
  const [logoUrl, setLogoUrl] = useState('')

  const [salvando, setSalvando] = useState(false)
  const [uploadandoBanner, setUploadandoBanner] = useState(false)
  const [uploadandoLogo, setUploadandoLogo] = useState(false)
  const [erro, setErro] = useState(null)
  const [sucesso, setSucesso] = useState(false)

  useEffect(() => {
    if (!empresa) return
    setNome(empresa.nome ?? '')
    setDescricao(empresa.descricao ?? '')
    setEmailContato(empresa.email_contato ?? '')
    setBannerUrl(empresa.banner_url ?? '')
    setLogoUrl(empresa.logo_url ?? '')
  }, [empresa])

  async function handleUploadBanner(e) {
    const file = e.target.files?.[0]
    if (!file || !empresa) return
    setUploadandoBanner(true)
    setErro(null)
    const ext = file.name.split('.').pop()
    const path = `${empresa.id}/banner.${ext}`
    const { error: upErr } = await supabase.storage
      .from('empresa-banners')
      .upload(path, file, { upsert: true })
    if (upErr) { setErro(upErr.message); setUploadandoBanner(false); return }
    const { data } = supabase.storage.from('empresa-banners').getPublicUrl(path)
    setBannerUrl(data.publicUrl)
    setUploadandoBanner(false)
  }

  async function handleUploadLogo(e) {
    const file = e.target.files?.[0]
    if (!file || !empresa) return
    setUploadandoLogo(true)
    setErro(null)
    const ext = file.name.split('.').pop()
    const path = `${empresa.id}/logo.${ext}`
    const { error: upErr } = await supabase.storage
      .from('empresa-banners')
      .upload(path, file, { upsert: true })
    if (upErr) { setErro(upErr.message); setUploadandoLogo(false); return }
    const { data } = supabase.storage.from('empresa-banners').getPublicUrl(path)
    setLogoUrl(data.publicUrl)
    setUploadandoLogo(false)
  }

  async function handleSalvar(e) {
    e.preventDefault()
    if (!empresa) return
    setSalvando(true)
    setErro(null)
    setSucesso(false)
    const { error } = await supabase
      .from('empresas')
      .update({ nome, descricao, email_contato: emailContato, banner_url: bannerUrl, logo_url: logoUrl })
      .eq('id', empresa.id)
    setSalvando(false)
    if (error) { setErro(error.message); return }
    await refreshProfile()
    setSucesso(true)
    setTimeout(() => setSucesso(false), 3000)
  }

  if (!empresa) return null

  return (
    <div>
      <div className="page-header">
        <h1>Minha Loja</h1>
      </div>

      {erro && (
        <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 14 }}>
          {erro}
        </div>
      )}
      {sucesso && (
        <div style={{ background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 14 }}>
          Salvo com sucesso.
        </div>
      )}

      <form onSubmit={handleSalvar}>
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, marginTop: 0 }}>Informações da loja</h2>
          <div className="form-grid">
            <div className="form-field full">
              <label>Nome da loja</label>
              <input value={nome} onChange={e => setNome(e.target.value)} required />
            </div>
            <div className="form-field full">
              <label>E-mail de contato</label>
              <input type="email" value={emailContato} onChange={e => setEmailContato(e.target.value)} />
            </div>
            <div className="form-field full">
              <label>Descrição pública</label>
              <textarea
                value={descricao}
                onChange={e => setDescricao(e.target.value)}
                rows={3}
                style={{ resize: 'vertical' }}
                placeholder="Ex: Depósito de bebidas com entrega rápida na região..."
              />
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, marginTop: 0 }}>Banner da loja</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
            Imagem exibida no topo do card da sua loja no portal dos clientes. Recomendado: 1200x300px.
          </p>
          {bannerUrl && (
            <div style={{ width: '100%', height: 140, borderRadius: 10, overflow: 'hidden', marginBottom: 12, border: '1px solid var(--border)' }}>
              <img src={bannerUrl} alt="Banner" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </div>
          )}
          <label
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: 'var(--surface)', border: '1.5px solid var(--border)',
              borderRadius: 8, padding: '8px 14px', cursor: 'pointer',
              fontSize: 14, fontWeight: 600, color: 'var(--text)',
              transition: 'border-color 120ms',
            }}
          >
            {uploadandoBanner ? 'Enviando...' : 'Selecionar imagem'}
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleUploadBanner}
              disabled={uploadandoBanner}
            />
          </label>
        </div>

        <div className="card" style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, marginTop: 0 }}>Logo da loja</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
            Logo exibida sobre o banner no portal dos clientes. Recomendado: imagem quadrada 200x200px.
          </p>
          {logoUrl && (
            <div style={{ width: 80, height: 80, borderRadius: 12, overflow: 'hidden', marginBottom: 12, border: '1px solid var(--border)' }}>
              <img src={logoUrl} alt="Logo" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            </div>
          )}
          <label
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: 'var(--surface)', border: '1.5px solid var(--border)',
              borderRadius: 8, padding: '8px 14px', cursor: 'pointer',
              fontSize: 14, fontWeight: 600, color: 'var(--text)',
              transition: 'border-color 120ms',
            }}
          >
            {uploadandoLogo ? 'Enviando...' : 'Selecionar imagem'}
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleUploadLogo}
              disabled={uploadandoLogo}
            />
          </label>
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={salvando || uploadandoBanner || uploadandoLogo}
        >
          {salvando ? 'Salvando...' : 'Salvar'}
        </button>
      </form>
    </div>
  )
}
