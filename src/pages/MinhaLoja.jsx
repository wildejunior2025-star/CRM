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
  const [emailLogin, setEmailLogin] = useState('')
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

  const [senhaNova, setSenhaNova] = useState('')
  const [senhaConfirm, setSenhaConfirm] = useState('')
  const [salvandoSenha, setSalvandoSenha] = useState(false)
  const [erroSenha, setErroSenha] = useState(null)
  const [sucessoSenha, setSucessoSenha] = useState(false)

  // Integração iFood
  const [ifoodCfg, setIfoodCfg] = useState({
    client_id: '', client_secret: '', merchant_id: '', ambiente: 'producao', ativo: false,
  })
  const [ifoodStatus, setIfoodStatus] = useState(null) // { ultimo_polling_em, ultimo_erro }
  const [ifoodSalvando, setIfoodSalvando] = useState(false)
  const [ifoodTestando, setIfoodTestando] = useState(false)
  const [ifoodMsg, setIfoodMsg] = useState(null) // { tipo: 'ok'|'erro', texto }
  const [ifoodAjuda, setIfoodAjuda] = useState(false) // popup "onde encontro o Merchant ID"

  async function handleSalvarIfood(e) {
    e.preventDefault()
    if (!empresa) return
    setIfoodSalvando(true)
    setIfoodMsg(null)
    const { error } = await supabase
      .from('ifood_config')
      .upsert({
        empresa_id: empresa.id,
        merchant_id: ifoodCfg.merchant_id.trim() || null,
        ambiente: ifoodCfg.ambiente,
        ativo: ifoodCfg.ativo,
      }, { onConflict: 'empresa_id' })
    setIfoodSalvando(false)
    if (error) { setIfoodMsg({ tipo: 'erro', texto: error.message }); return }
    setIfoodMsg({ tipo: 'ok', texto: 'Configuração do iFood salva.' })
    setTimeout(() => setIfoodMsg(null), 3000)
  }

  async function handleTestarIfood() {
    if (!empresa) return
    setIfoodTestando(true)
    setIfoodMsg(null)
    // Salva antes de testar pra garantir que a edge function lê o que está na tela
    await supabase.from('ifood_config').upsert({
      empresa_id: empresa.id,
      merchant_id: ifoodCfg.merchant_id.trim() || null,
      ambiente: ifoodCfg.ambiente,
      ativo: ifoodCfg.ativo,
    }, { onConflict: 'empresa_id' })

    try {
      const { data: { session } } = await supabase.auth.getSession()
      const url = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'}/functions/v1/ifood-integration`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ acao: 'test', empresa_id: empresa.id }),
      })
      const data = await res.json()
      if (data.ok) setIfoodMsg({ tipo: 'ok', texto: data.mensagem ?? 'Conexão OK!' })
      else setIfoodMsg({ tipo: 'erro', texto: data.error ?? 'Falha ao conectar' })
    } catch (err) {
      setIfoodMsg({ tipo: 'erro', texto: String(err.message ?? err) })
    }
    setIfoodTestando(false)
  }

  async function handleAlterarSenha(e) {
    e.preventDefault()
    setErroSenha(null)
    if (senhaNova.length < 6) { setErroSenha('A senha deve ter pelo menos 6 caracteres.'); return }
    if (senhaNova !== senhaConfirm) { setErroSenha('As senhas não coincidem.'); return }
    setSalvandoSenha(true)
    const { error } = await supabase.auth.updateUser({ password: senhaNova })
    setSalvandoSenha(false)
    if (error) { setErroSenha(error.message); return }
    setSenhaNova('')
    setSenhaConfirm('')
    setSucessoSenha(true)
    setTimeout(() => setSucessoSenha(false), 3000)
  }

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
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user?.email) setEmailLogin(user.email)
    })
    supabase.from('ifood_config').select('*').eq('empresa_id', empresa.id).maybeSingle()
      .then(({ data }) => {
        if (!data) return
        setIfoodCfg({
          client_id: data.client_id ?? '',
          client_secret: data.client_secret ?? '',
          merchant_id: data.merchant_id ?? '',
          ambiente: data.ambiente ?? 'teste',
          ativo: data.ativo ?? false,
        })
        setIfoodStatus({ ultimo_polling_em: data.ultimo_polling_em, ultimo_erro: data.ultimo_erro })
      })
  }, [empresa])

  const [salvandoEmail, setSalvandoEmail] = useState(false)
  const [erroEmail, setErroEmail] = useState(null)
  const [sucessoEmail, setSucessoEmail] = useState(false)

  async function handleAlterarEmail(e) {
    e.preventDefault()
    setErroEmail(null)
    if (!emailLogin.includes('@')) { setErroEmail('E-mail inválido.'); return }
    setSalvandoEmail(true)
    const { error } = await supabase.auth.updateUser({ email: emailLogin })
    setSalvandoEmail(false)
    if (error) { setErroEmail(error.message); return }
    setSucessoEmail(true)
    setTimeout(() => setSucessoEmail(false), 5000)
  }

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

  const linkCatalogo = `https://lojaonline.fwcinter.com/${empresa.slug ?? empresa.id}`

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

      {/* Card de integração com o iFood */}
      <form onSubmit={handleSalvarIfood} style={{ marginTop: 16 }}>
        <div className="card" style={{ marginBottom: 16, borderTop: '3px solid #ea1d2c' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span style={{
              background: '#ea1d2c', color: '#fff', borderRadius: 6,
              padding: '3px 8px', fontSize: 12, fontWeight: 800, letterSpacing: '.02em',
            }}>iFood</span>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>Integração com o iFood</h2>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
            Os pedidos que caírem no iFood aparecem aqui no painel automaticamente. A integração
            já está configurada pela FWC — você só precisa informar o <strong>ID da sua loja no
            iFood (Merchant ID)</strong> e ativar.
          </p>

          {ifoodMsg && (
            <div style={{
              background: ifoodMsg.tipo === 'ok' ? 'var(--success-bg)' : 'var(--danger-bg)',
              color: ifoodMsg.tipo === 'ok' ? 'var(--success)' : 'var(--danger)',
              border: `1px solid ${ifoodMsg.tipo === 'ok' ? 'var(--success)' : 'var(--danger)'}`,
              borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14,
            }}>
              {ifoodMsg.texto}
            </div>
          )}

          <label style={{
            display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
            padding: '10px 14px', borderRadius: 8, marginBottom: 16,
            border: `1.5px solid ${ifoodCfg.ativo ? '#ea1d2c' : 'var(--border)'}`,
            background: ifoodCfg.ativo ? 'rgba(234,29,44,.08)' : 'transparent',
          }}>
            <input
              type="checkbox"
              checked={ifoodCfg.ativo}
              onChange={e => setIfoodCfg(c => ({ ...c, ativo: e.target.checked }))}
              style={{ width: 18, height: 18, cursor: 'pointer' }}
            />
            <span style={{ fontWeight: 700, fontSize: 14 }}>
              Receber pedidos do iFood {ifoodCfg.ativo ? '(ativo)' : '(desligado)'}
            </span>
          </label>

          <div className="form-grid">
            <div className="form-field full">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                ID da sua loja no iFood (Merchant ID)
                <button
                  type="button"
                  onClick={() => setIfoodAjuda(true)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    background: 'var(--primary-bg, #f5f0ff)', color: 'var(--primary)',
                    border: '1px solid var(--primary)', borderRadius: 999,
                    padding: '2px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                  }}
                >
                  ❓ Onde encontro?
                </button>
              </label>
              <input
                type="text"
                value={ifoodCfg.merchant_id}
                onChange={e => setIfoodCfg(c => ({ ...c, merchant_id: e.target.value }))}
                placeholder="ex: 1b2c3d4e-5678-..."
              />
              <small style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                É o código da sua loja no iFood. Não tem em mãos? Fale com a FWC que a gente pega pra você.
              </small>
            </div>
            <div className="form-field">
              <label>Ambiente</label>
              <select
                value={ifoodCfg.ambiente}
                onChange={e => setIfoodCfg(c => ({ ...c, ambiente: e.target.value }))}
              >
                <option value="producao">Produção (loja real)</option>
                <option value="teste">Teste</option>
              </select>
            </div>
          </div>

          {ifoodStatus?.ultimo_polling_em && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, marginBottom: 0 }}>
              Última verificação: {new Date(ifoodStatus.ultimo_polling_em).toLocaleString('pt-BR')}
              {ifoodStatus.ultimo_erro && (
                <span style={{ color: 'var(--danger)' }}> · último erro: {ifoodStatus.ultimo_erro}</span>
              )}
            </p>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={ifoodSalvando}>
              {ifoodSalvando ? 'Salvando...' : 'Salvar integração'}
            </button>
            <button
              type="button"
              onClick={handleTestarIfood}
              disabled={ifoodTestando}
              style={{
                padding: '8px 18px', borderRadius: 8, cursor: 'pointer',
                border: '1.5px solid var(--border)', background: 'var(--surface)',
                fontWeight: 700, fontSize: 14, color: 'var(--text)',
              }}
            >
              {ifoodTestando ? 'Testando...' : 'Testar conexão'}
            </button>
          </div>
        </div>
      </form>

      {/* Popup: onde encontrar o Merchant ID */}
      {ifoodAjuda && (
        <div
          onClick={() => setIfoodAjuda(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,.5)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface, #fff)', borderRadius: 14, maxWidth: 460, width: '100%',
              maxHeight: '90vh', overflowY: 'auto', padding: '22px 22px 20px',
              boxShadow: '0 20px 60px rgba(0,0,0,.3)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ background: '#ea1d2c', color: '#fff', borderRadius: 6, padding: '2px 7px', fontSize: 11, fontWeight: 800 }}>iFood</span>
                Onde achar o Merchant ID
              </h3>
              <button
                type="button"
                onClick={() => setIfoodAjuda(false)}
                style={{ background: 'none', border: 'none', fontSize: 22, lineHeight: 1, cursor: 'pointer', color: 'var(--text-muted)' }}
                aria-label="Fechar"
              >×</button>
            </div>

            <p style={{ fontSize: 13.5, color: 'var(--text-muted)', marginTop: 0, marginBottom: 14 }}>
              O Merchant ID é o código da sua loja no iFood. Veja como pegar:
            </p>

            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.6, color: 'var(--text)' }}>
              <li>Entre no <strong>Portal do Parceiro do iFood</strong> em <strong>portal.ifood.com.br</strong> com o login da sua loja.</li>
              <li>No menu, abra <strong>“Configurações”</strong> (ou “Dados da loja” / “Minha loja”).</li>
              <li>Procure por <strong>“ID da loja”</strong>, <strong>“Merchant ID”</strong> ou “código da loja”.</li>
              <li><strong>Copie</strong> esse código e <strong>cole aqui</strong> no campo Merchant ID.</li>
            </ol>

            <div style={{
              marginTop: 16, padding: '12px 14px', borderRadius: 10,
              background: 'var(--primary-bg, #f5f0ff)', border: '1px solid var(--primary)',
              fontSize: 13, color: 'var(--text)',
            }}>
              💬 <strong>Não achou ou tem dúvida?</strong> Fale com a FWC no WhatsApp{' '}
              <a
                href="https://wa.me/5584999281009?text=Ol%C3%A1%21%20Preciso%20de%20ajuda%20para%20pegar%20o%20Merchant%20ID%20da%20minha%20loja%20no%20iFood."
                target="_blank" rel="noopener noreferrer"
                style={{ color: 'var(--primary)', fontWeight: 700 }}
              >(84) 99928-1009</a> que a gente pega esse código pra você.
            </div>

            <button
              type="button"
              onClick={() => setIfoodAjuda(false)}
              className="btn btn-primary"
              style={{ width: '100%', marginTop: 16 }}
            >
              Entendi
            </button>
          </div>
        </div>
      )}

      {/* Card de alteração de e-mail de login */}
      <form onSubmit={handleAlterarEmail} style={{ marginTop: 16 }}>
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>E-mail de acesso</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
            Este é o e-mail usado para fazer login no sistema.
          </p>

          {erroEmail && (
            <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14 }}>
              {erroEmail}
            </div>
          )}
          {sucessoEmail && (
            <div style={{ background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14 }}>
              Confirmação enviada para o novo e-mail. Clique no link para confirmar a troca.
            </div>
          )}

          <div className="form-grid">
            <div className="form-field full">
              <label>E-mail de login</label>
              <input
                type="email"
                value={emailLogin}
                onChange={e => setEmailLogin(e.target.value)}
                placeholder="seu@email.com"
                autoComplete="email"
              />
            </div>
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={salvandoEmail} style={{ marginBottom: 16 }}>
          {salvandoEmail ? 'Salvando...' : 'Salvar e-mail'}
        </button>
      </form>

      {/* Card de alteração de senha */}
      <form onSubmit={handleAlterarSenha} style={{ marginTop: 0 }}>
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>Alterar senha</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
            Defina uma nova senha para acessar o sistema.
          </p>

          {erroSenha && (
            <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14 }}>
              {erroSenha}
            </div>
          )}
          {sucessoSenha && (
            <div style={{ background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14 }}>
              Senha alterada com sucesso!
            </div>
          )}

          <div className="form-grid">
            <div className="form-field">
              <label>Nova senha</label>
              <input
                type="password"
                value={senhaNova}
                onChange={e => setSenhaNova(e.target.value)}
                placeholder="Mínimo 6 caracteres"
                autoComplete="new-password"
              />
            </div>
            <div className="form-field">
              <label>Confirmar nova senha</label>
              <input
                type="password"
                value={senhaConfirm}
                onChange={e => setSenhaConfirm(e.target.value)}
                placeholder="Repita a nova senha"
                autoComplete="new-password"
              />
            </div>
          </div>
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={salvandoSenha}
        >
          {salvandoSenha ? 'Alterando...' : 'Alterar senha'}
        </button>
      </form>
    </div>
  )
}
