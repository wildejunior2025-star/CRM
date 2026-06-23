import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'
import { CONDICOES_PAGAMENTO, ICONE_PAGAMENTO } from '../lib/constants'
import '../components/Page.css'

export default function MinhaLoja() {
  const { empresa, refreshProfile } = useAuth()

  const [nome, setNome] = useState('')
  const [descricao, setDescricao] = useState('')
  const [emailContato, setEmailContato] = useState('')
  const [bannerUrl, setBannerUrl] = useState('')
  const [logoUrl, setLogoUrl] = useState('')

  const [formasPagamento, setFormasPagamento] = useState(['a_vista', 'fiado', 'boleto_7d', 'boleto_14d', 'boleto_30d'])

  const [chavePix, setChavePix] = useState('')
  const [pixNome, setPixNome] = useState('')
  const [pixCidade, setPixCidade] = useState('')

  const [salvando, setSalvando] = useState(false)
  const [uploadandoBanner, setUploadandoBanner] = useState(false)
  const [uploadandoLogo, setUploadandoLogo] = useState(false)
  const [erro, setErro] = useState(null)
  const [sucesso, setSucesso] = useState(false)
  const [copiado, setCopiado] = useState(false)
  const timerCopia = useRef(null)

  useEffect(() => {
    if (!empresa) return
    setNome(empresa.nome ?? '')
    setDescricao(empresa.descricao ?? '')
    setEmailContato(empresa.email_contato ?? '')
    setBannerUrl(empresa.banner_url ?? '')
    setLogoUrl(empresa.logo_url ?? '')
    setFormasPagamento(empresa.formas_pagamento ?? ['a_vista', 'fiado', 'boleto_7d', 'boleto_14d', 'boleto_30d'])
    setChavePix(empresa.chave_pix ?? '')
    setPixNome(empresa.pix_nome ?? '')
    setPixCidade(empresa.pix_cidade ?? '')
  }, [empresa])

  async function handleUploadBanner(e) {
    const file = e.target.files?.[0]
    if (!file || !empresa) return
    setUploadandoBanner(true)
    setErro(null)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setErro('Sessão expirada. Faça login novamente.'); setUploadandoBanner(false); return }
    const ext = file.name.split('.').pop()
    const path = `${empresa.id}/banner.${ext}`
    await supabase.storage.from('empresa-banners').remove([path])
    const { error: upErr } = await supabase.storage
      .from('empresa-banners')
      .upload(path, file)
    if (upErr) { setErro(`Erro: ${upErr.message} | status: ${upErr.statusCode ?? upErr.status ?? '?'}`); setUploadandoBanner(false); return }
    const { data } = supabase.storage.from('empresa-banners').getPublicUrl(path)
    setBannerUrl(data.publicUrl)
    setUploadandoBanner(false)
  }

  async function handleUploadLogo(e) {
    const file = e.target.files?.[0]
    if (!file || !empresa) return
    setUploadandoLogo(true)
    setErro(null)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setErro('Sessão expirada. Faça login novamente.'); setUploadandoLogo(false); return }
    const ext = file.name.split('.').pop()
    const path = `${empresa.id}/logo.${ext}`
    await supabase.storage.from('empresa-banners').remove([path])
    const { error: upErr } = await supabase.storage
      .from('empresa-banners')
      .upload(path, file)
    if (upErr) { setErro(`Erro: ${upErr.message} | status: ${upErr.statusCode ?? upErr.status ?? '?'}`); setUploadandoLogo(false); return }
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
      .update({
        nome,
        descricao,
        email_contato: emailContato,
        banner_url: bannerUrl,
        logo_url: logoUrl,
        formas_pagamento: formasPagamento,
        chave_pix: chavePix || null,
        pix_nome: pixNome || null,
        pix_cidade: pixCidade || null,
      })
      .eq('id', empresa.id)
    setSalvando(false)
    if (error) { setErro(error.message); return }
    await refreshProfile()
    setSucesso(true)
    setTimeout(() => setSucesso(false), 3000)
  }

  if (!empresa) return null

  const linkCatalogo = `${window.location.origin}/portal/loja/${empresa.slug ?? empresa.id}`

  function copiarLink() {
    navigator.clipboard.writeText(linkCatalogo)
    setCopiado(true)
    clearTimeout(timerCopia.current)
    timerCopia.current = setTimeout(() => setCopiado(false), 2500)
  }

  return (
    <div>
      <div className="page-header">
        <h1>Minha Loja</h1>
      </div>

      {/* Card do link do catálogo digital */}
      <div className="card" style={{ marginBottom: 20, padding: '18px 20px' }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
          Link do seu catálogo digital
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
          Compartilhe com seus clientes para que eles vejam seus produtos e façam pedidos online.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{
            flex: 1, minWidth: 0,
            background: 'var(--bg)', border: '1.5px solid var(--border)',
            borderRadius: 8, padding: '8px 12px',
            fontSize: 13, color: 'var(--text-muted)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {linkCatalogo}
          </div>
          <button
            type="button"
            onClick={copiarLink}
            style={{
              padding: '8px 18px', borderRadius: 8, border: 'none',
              cursor: 'pointer', fontWeight: 700, fontSize: 13,
              background: copiado ? '#16a34a' : 'var(--primary)',
              color: '#fff', whiteSpace: 'nowrap', transition: 'background 200ms',
            }}
          >
            {copiado ? '✔ Copiado!' : 'Copiar link'}
          </button>
          <a
            href={linkCatalogo}
            target="_blank"
            rel="noreferrer"
            style={{
              padding: '8px 14px', borderRadius: 8,
              border: '1.5px solid var(--border)',
              fontSize: 13, fontWeight: 600, color: 'var(--text)',
              textDecoration: 'none', whiteSpace: 'nowrap',
              background: 'var(--surface)',
            }}
          >
            Abrir
          </a>
        </div>
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
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 8 }}>
            Imagem exibida no topo do card da sua loja no portal dos clientes.
          </p>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--primary-bg)', color: 'var(--primary)',
            border: '1px solid var(--primary)', borderRadius: 6,
            padding: '4px 10px', fontSize: 12, fontWeight: 600,
            marginBottom: 14,
          }}>
            Tamanho ideal: 1200 × 300 px · Máximo 2 MB · JPG ou PNG
          </span>
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

        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, marginTop: 0 }}>Logo da loja</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 8 }}>
            Logo exibida sobre o banner no portal dos clientes.
          </p>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--primary-bg)', color: 'var(--primary)',
            border: '1px solid var(--primary)', borderRadius: 6,
            padding: '4px 10px', fontSize: 12, fontWeight: 600,
            marginBottom: 14,
          }}>
            Tamanho ideal: 200 × 200 px · Formato quadrado · PNG recomendado
          </span>
          <div style={{ marginBottom: 14 }}>
            {logoUrl ? (
              <div style={{
                width: 96, height: 96, borderRadius: '50%', overflow: 'hidden',
                border: '3px solid var(--primary)',
                flexShrink: 0,
              }}>
                <img
                  src={logoUrl}
                  alt="Logo"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center', display: 'block' }}
                />
              </div>
            ) : (
              <div style={{
                width: 96, height: 96, borderRadius: '50%',
                border: '3px solid var(--primary)',
                background: 'var(--primary-bg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--primary)', lineHeight: 1, letterSpacing: '-0.02em' }}>
                  {nome ? nome.trim().charAt(0).toUpperCase() : '?'}
                </span>
              </div>
            )}
          </div>
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

        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>Formas de pagamento aceitas</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 14 }}>
            Marque as formas que aparecem na hora de registrar uma venda.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {CONDICOES_PAGAMENTO.map((op) => {
              const icone = ICONE_PAGAMENTO[op.value]
              const ativo = formasPagamento.includes(op.value)
              return (
                <label key={op.value} style={{
                  display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                  padding: '8px 12px', borderRadius: 8, fontSize: 14,
                  border: `1.5px solid ${ativo ? 'var(--primary)' : 'var(--border)'}`,
                  background: ativo ? 'var(--primary-bg)' : 'transparent',
                  transition: 'all 120ms',
                }}>
                  <input
                    type="checkbox"
                    checked={ativo}
                    onChange={(e) => {
                      setFormasPagamento(prev =>
                        e.target.checked ? [...prev, op.value] : prev.filter(v => v !== op.value)
                      )
                    }}
                    style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
                  />
                  {icone && (
                    <span style={{
                      background: icone.bg, color: icone.text,
                      borderRadius: 4, padding: '2px 5px',
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
                      flexShrink: 0, minWidth: 28, textAlign: 'center',
                    }}>
                      {icone.label}
                    </span>
                  )}
                  {op.label}
                </label>
              )
            })}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>Pagamento PIX</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
            Chave PIX exibida no checkout para seus clientes pagarem pedidos.
          </p>
          <div className="form-grid">
            <div className="form-field full">
              <label>Chave PIX</label>
              <input
                type="text"
                value={chavePix}
                onChange={e => setChavePix(e.target.value)}
                maxLength={140}
                placeholder="CPF, CNPJ, e-mail, telefone ou chave aleatória"
              />
            </div>
            <div className="form-field">
              <label>Nome do recebedor</label>
              <input
                type="text"
                value={pixNome}
                onChange={e => setPixNome(e.target.value.toUpperCase())}
                maxLength={25}
                placeholder="JOAO DA SILVA"
                style={{ textTransform: 'uppercase' }}
              />
            </div>
            <div className="form-field">
              <label>Cidade do recebedor</label>
              <input
                type="text"
                value={pixCidade}
                onChange={e => setPixCidade(e.target.value.toUpperCase())}
                maxLength={15}
                placeholder="SAO PAULO"
                style={{ textTransform: 'uppercase' }}
              />
            </div>
          </div>
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
