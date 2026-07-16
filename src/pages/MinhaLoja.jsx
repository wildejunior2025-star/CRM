import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'
import { CONDICOES_PAGAMENTO, ICONE_PAGAMENTO } from '../lib/constants'
import IfoodCatalogoManager from '../components/IfoodCatalogoManager'
import '../components/Page.css'

export default function MinhaLoja({ secao = 'loja' }) {
  const { empresa, refreshProfile } = useAuth()
  const SECAO_TITULO = { loja: 'Minha Loja', pagamentos: 'Pagamento', integracoes: 'Integrações', fiscal: 'Nota Fiscal', conta: 'Conta' }

  const [nome, setNome] = useState('')
  const [descricao, setDescricao] = useState('')
  const [emailContato, setEmailContato] = useState('')
  const [emailLogin, setEmailLogin] = useState('')
  // Dados do responsável (aba Conta)
  const [nomeResponsavel, setNomeResponsavel] = useState('')
  const [cnpj, setCnpj] = useState('')
  const [telefoneContato, setTelefoneContato] = useState('')
  const [salvandoDados, setSalvandoDados] = useState(false)
  const [erroDados, setErroDados] = useState(null)
  const [sucessoDados, setSucessoDados] = useState(false)
  const [bannerUrl, setBannerUrl] = useState('')
  const [logoUrl, setLogoUrl] = useState('')

  const [formasPagamento, setFormasPagamento] = useState(['a_vista', 'fiado', 'boleto_7d', 'boleto_14d', 'boleto_30d'])

  const [chavePix, setChavePix] = useState('')
  const [pixNome, setPixNome] = useState('')
  const [pixCidade, setPixCidade] = useState('')

  const [mpConectando, setMpConectando] = useState(false)
  const [mpMsg, setMpMsg] = useState(null)

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
    auto_criar_produtos: false,
  })
  const [ifoodStatus, setIfoodStatus] = useState(null) // { ultimo_polling_em, ultimo_erro }
  const [ifoodSalvando, setIfoodSalvando] = useState(false)
  const [ifoodTestando, setIfoodTestando] = useState(false)
  const [ifoodImportando, setIfoodImportando] = useState(false)
  const [ifoodMsg, setIfoodMsg] = useState(null) // { tipo: 'ok'|'erro', texto }
  // F3 — gerenciar itens do iFood (pausar/despausar)
  const [ifoodItens, setIfoodItens] = useState(null) // null = não carregado
  const [ifoodItensLoading, setIfoodItensLoading] = useState(false)
  const [ifoodPausandoId, setIfoodPausandoId] = useState(null)
  const [ifoodAjuda, setIfoodAjuda] = useState(false) // popup "onde encontro o Merchant ID"

  // Nota Fiscal (NFC-e) — cadastro fiscal da loja (opt-in, desligado por padrão)
  const [fiscalCfg, setFiscalCfg] = useState({
    ativo: false, inscricao_estadual: '', regime_tributario: 'simples',
    csc: '', csc_id: '', serie: 1, ambiente: 'homologacao', emissor_token: '',
    ncm_padrao: '21069090', cfop_padrao: '5102', csosn_padrao: '102', origem_padrao: '0',
  })
  const [fiscalSalvando, setFiscalSalvando] = useState(false)
  const [fiscalMsg, setFiscalMsg] = useState(null) // { tipo, texto }
  // Certificado A1 + registro no emissor (Focus)
  const [certNome, setCertNome] = useState('')       // nome do .pfx já subido
  const [certRegistrada, setCertRegistrada] = useState(false)
  const [certArquivo, setCertArquivo] = useState(null) // File selecionado
  const [certSenha, setCertSenha] = useState('')
  const [certEnviando, setCertEnviando] = useState(false)
  const certInputRef = useRef(null)

  const FN_BASE = import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'

  async function handleSubirCertificado(e) {
    e.preventDefault()
    if (!empresa) return
    if (!certArquivo) { setFiscalMsg({ tipo: 'erro', texto: 'Escolha o arquivo do certificado (.pfx)' }); return }
    if (!certSenha) { setFiscalMsg({ tipo: 'erro', texto: 'Informe a senha do certificado' }); return }
    setCertEnviando(true)
    setFiscalMsg(null)

    // 1) sobe o .pfx no bucket privado (path = empresa_id/certificado.pfx)
    const ext = certArquivo.name.split('.').pop().toLowerCase()
    const path = `${empresa.id}/certificado.${ext === 'p12' ? 'p12' : 'pfx'}`
    const up = await supabase.storage.from('certificados-fiscais')
      .upload(path, certArquivo, { upsert: true, contentType: 'application/x-pkcs12' })
    if (up.error) {
      setCertEnviando(false)
      setFiscalMsg({ tipo: 'erro', texto: `Erro ao subir o certificado: ${up.error.message}` })
      return
    }
    // 2) guarda a referência no cadastro fiscal
    await supabase.from('empresa_fiscal').upsert({
      empresa_id: empresa.id, certificado_ref: path, certificado_nome: certArquivo.name,
    })

    // 3) registra a loja no emissor (Focus) mandando a senha (não fica salva)
    const { data: { session } } = await supabase.auth.getSession()
    let resp
    try {
      const r = await fetch(`${FN_BASE}/functions/v1/emitir-nfce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ acao: 'registrar_empresa', empresa_id: empresa.id, senha_certificado: certSenha }),
      })
      resp = await r.json()
    } catch (err) {
      resp = { ok: false, error: String(err) }
    }

    setCertEnviando(false)
    setCertSenha('')
    setCertArquivo(null)
    if (certInputRef.current) certInputRef.current.value = ''
    setCertNome(certArquivo.name)
    if (resp?.ok) {
      setCertRegistrada(true)
      setFiscalMsg({ tipo: 'ok', texto: resp.mensagem || 'Loja registrada no emissor. Já pode emitir NFC-e!' })
    } else {
      setCertRegistrada(false)
      setFiscalMsg({ tipo: 'erro', texto: resp?.error || 'Não foi possível registrar no emissor.' })
    }
  }

  async function handleSalvarFiscal(e) {
    e.preventDefault()
    if (!empresa) return
    setFiscalSalvando(true)
    setFiscalMsg(null)
    const { error } = await supabase.from('empresa_fiscal').upsert({
      empresa_id: empresa.id,
      ativo: fiscalCfg.ativo,
      inscricao_estadual: fiscalCfg.inscricao_estadual.trim() || null,
      regime_tributario: fiscalCfg.regime_tributario,
      csc: fiscalCfg.csc.trim() || null,
      csc_id: fiscalCfg.csc_id.trim() || null,
      serie: Number(fiscalCfg.serie) || 1,
      ambiente: fiscalCfg.ambiente,
      emissor_token: fiscalCfg.emissor_token.trim() || null,
      ncm_padrao: fiscalCfg.ncm_padrao.trim() || null,
      cfop_padrao: fiscalCfg.cfop_padrao.trim() || null,
      csosn_padrao: fiscalCfg.csosn_padrao.trim() || null,
      origem_padrao: fiscalCfg.origem_padrao.trim() || null,
    })
    setFiscalSalvando(false)
    setFiscalMsg(error
      ? { tipo: 'erro', texto: error.message }
      : { tipo: 'ok', texto: 'Dados fiscais salvos.' })
  }

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
        auto_criar_produtos: ifoodCfg.auto_criar_produtos,
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
      auto_criar_produtos: ifoodCfg.auto_criar_produtos,
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

  async function handleImportarCardapio() {
    if (!empresa) return
    setIfoodImportando(true)
    setIfoodMsg(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const url = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'}/functions/v1/ifood-integration`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ acao: 'catalogo', empresa_id: empresa.id }),
      })
      const data = await res.json()
      if (data.ok) {
        setIfoodMsg({
          tipo: 'ok',
          texto: data.criados > 0
            ? `Cardápio importado! ${data.criados} produto(s) novo(s) adicionado(s) (de ${data.total} encontrados). Veja em Produtos.`
            : `Nenhum produto novo pra importar (${data.total} já estavam no sistema).`,
        })
      } else {
        setIfoodMsg({ tipo: 'erro', texto: data.error ?? 'Falha ao importar o cardápio' })
      }
    } catch (err) {
      setIfoodMsg({ tipo: 'erro', texto: String(err.message ?? err) })
    }
    setIfoodImportando(false)
  }

  // F3 — chamadas de catálogo (listar / pausar item no iFood)
  async function chamarIfood(payload) {
    const { data: { session } } = await supabase.auth.getSession()
    const url = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'}/functions/v1/ifood-integration`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify(payload),
    })
    return res.json()
  }

  async function carregarItensIfood() {
    setIfoodItensLoading(true)
    setIfoodMsg(null)
    const data = await chamarIfood({ acao: 'catalogo_listar', empresa_id: empresa.id })
    if (data.ok) setIfoodItens(data.itens ?? [])
    else { setIfoodItens(null); setIfoodMsg({ tipo: 'erro', texto: data.error ?? 'Falha ao listar itens do iFood' }) }
    setIfoodItensLoading(false)
  }

  async function pausarItemIfood(item, pausar) {
    setIfoodPausandoId(item.id)
    const data = await chamarIfood({ acao: 'catalogo_pausar', empresa_id: empresa.id, item_id: item.id, pausar })
    if (data.ok) {
      setIfoodItens(prev => (prev ?? []).map(x => x.id === item.id ? { ...x, status: pausar ? 'UNAVAILABLE' : 'AVAILABLE' } : x))
    } else {
      setIfoodMsg({ tipo: 'erro', texto: data.error ?? 'Falha ao pausar o item no iFood' })
    }
    setIfoodPausandoId(null)
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
    setNomeResponsavel(empresa.nome_responsavel ?? '')
    setCnpj(empresa.cnpj ?? '')
    setTelefoneContato(empresa.telefone_contato ?? '')
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
          auto_criar_produtos: data.auto_criar_produtos ?? false,
        })
        setIfoodStatus({ ultimo_polling_em: data.ultimo_polling_em, ultimo_erro: data.ultimo_erro })
      })
    supabase.from('empresa_fiscal').select('*').eq('empresa_id', empresa.id).maybeSingle()
      .then(({ data }) => {
        if (!data) return
        setFiscalCfg({
          ativo: data.ativo ?? false,
          inscricao_estadual: data.inscricao_estadual ?? '',
          regime_tributario: data.regime_tributario ?? 'simples',
          csc: data.csc ?? '',
          csc_id: data.csc_id ?? '',
          serie: data.serie ?? 1,
          ambiente: data.ambiente ?? 'homologacao',
          emissor_token: data.emissor_token ?? '',
          ncm_padrao: data.ncm_padrao ?? '21069090',
          cfop_padrao: data.cfop_padrao ?? '5102',
          csosn_padrao: data.csosn_padrao ?? '102',
          origem_padrao: data.origem_padrao ?? '0',
        })
        setCertNome(data.certificado_nome ?? '')
        setCertRegistrada(data.focus_registrada ?? false)
      })
  }, [empresa])

  // ── Mercado Pago (conectar conta da loja p/ receber PIX direto) ──
  const MP_FN_BASE = import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'

  // Mostra o resultado ao voltar do Mercado Pago (?mp=ok / ?mp=erro)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('mp')
    if (p === 'ok') { setMpMsg({ tipo: 'ok', texto: 'Mercado Pago conectado com sucesso! Os PIX agora caem na sua conta.' }); refreshProfile?.() }
    else if (p === 'erro') { setMpMsg({ tipo: 'erro', texto: 'Não foi possível conectar. Tente novamente.' }) }
    if (p) window.history.replaceState({}, '', window.location.pathname)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function conectarMercadoPago() {
    setMpConectando(true); setMpMsg(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const returnUrl = window.location.origin + window.location.pathname
      const res = await fetch(
        `${MP_FN_BASE}/functions/v1/mercadopago-oauth?action=start&return_url=${encodeURIComponent(returnUrl)}`,
        { headers: { Authorization: `Bearer ${session?.access_token ?? ''}` } }
      )
      const data = await res.json()
      if (data.url) { window.location.href = data.url; return }
      setMpMsg({ tipo: 'erro', texto: data.error || 'Erro ao iniciar a conexão.' })
    } catch {
      setMpMsg({ tipo: 'erro', texto: 'Erro ao conectar. Verifique a internet.' })
    }
    setMpConectando(false)
  }

  async function desconectarMercadoPago() {
    if (!window.confirm('Desconectar sua conta Mercado Pago? Os PIX deixam de cair direto na sua conta.')) return
    setMpConectando(true); setMpMsg(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${MP_FN_BASE}/functions/v1/mercadopago-oauth?action=disconnect`, {
        method: 'POST', headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
      })
      if (res.ok) { setMpMsg({ tipo: 'ok', texto: 'Conta desconectada.' }); await refreshProfile?.() }
      else setMpMsg({ tipo: 'erro', texto: 'Erro ao desconectar.' })
    } catch {
      setMpMsg({ tipo: 'erro', texto: 'Erro ao desconectar.' })
    }
    setMpConectando(false)
  }

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

  // Salva os dados do responsável (aba Conta)
  async function handleSalvarDados(e) {
    e.preventDefault()
    if (!empresa) return
    setSalvandoDados(true); setErroDados(null); setSucessoDados(false)
    const { error } = await supabase
      .from('empresas')
      .update({
        nome_responsavel: nomeResponsavel.trim() || null,
        cnpj: cnpj.trim() || null,
        telefone_contato: telefoneContato.trim() || null,
        email_contato: emailContato.trim() || null,
      })
      .eq('id', empresa.id)
    setSalvandoDados(false)
    if (error) { setErroDados(error.message); return }
    await refreshProfile()
    setSucessoDados(true)
    setTimeout(() => setSucessoDados(false), 3000)
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
        <h1>{SECAO_TITULO[secao] ?? 'Minha Loja'}</h1>
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

      {secao === 'loja' && (
      <>
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

        <button
          type="submit"
          className="btn btn-primary"
          disabled={salvando || uploadandoBanner || uploadandoLogo}
        >
          {salvando ? 'Salvando...' : 'Salvar'}
        </button>
      </form>
      </>
      )}

      {secao === 'pagamentos' && (
      <form onSubmit={handleSalvar}>
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
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>Receber PIX automático (Mercado Pago)</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 14 }}>
            Conecte sua conta Mercado Pago para receber os PIX dos pedidos <strong>direto nela</strong>,
            com confirmação automática (o pedido cai na loja assim que o cliente paga).
          </p>

          {mpMsg && (
            <div style={{
              fontSize: 13, fontWeight: 600, padding: '10px 12px', borderRadius: 8, marginBottom: 12,
              background: mpMsg.tipo === 'ok' ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
              color: mpMsg.tipo === 'ok' ? '#16a34a' : '#dc2626',
            }}>{mpMsg.texto}</div>
          )}

          {empresa?.mp_conectado ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#16a34a' }}>● Conta conectada ✓</span>
              <button
                type="button"
                onClick={desconectarMercadoPago}
                disabled={mpConectando}
                style={{
                  fontSize: 13, fontWeight: 600, padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)',
                }}
              >
                {mpConectando ? 'Aguarde...' : 'Desconectar'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={conectarMercadoPago}
              disabled={mpConectando}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                fontSize: 14, fontWeight: 700, padding: '10px 18px', borderRadius: 10, cursor: 'pointer',
                border: 'none', background: '#009ee3', color: '#fff',
              }}
            >
              {mpConectando ? 'Abrindo o Mercado Pago...' : 'Conectar Mercado Pago'}
            </button>
          )}
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>Pagamento PIX (chave manual)</h2>
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
      )}

      {secao === 'integracoes' && (
      <>
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
            <button
              type="button"
              onClick={handleImportarCardapio}
              disabled={ifoodImportando || !ifoodCfg.merchant_id}
              title={!ifoodCfg.merchant_id ? 'Informe o Merchant ID primeiro' : ''}
              style={{
                padding: '8px 18px', borderRadius: 8, cursor: ifoodCfg.merchant_id ? 'pointer' : 'not-allowed',
                border: 'none', background: '#ea1d2c', color: '#fff',
                fontWeight: 700, fontSize: 14, opacity: ifoodCfg.merchant_id ? 1 : 0.5,
              }}
            >
              {ifoodImportando ? 'Importando...' : '📥 Importar cardápio do iFood'}
            </button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10, marginBottom: 10 }}>
            “Importar cardápio” copia os produtos da sua loja do iFood pra cá, de uma vez.
          </p>

          {/* F3 — Pausar/esgotar itens no iFood (precisa do módulo Catálogo homologado) */}
          <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 14 }}>Pausar itens no iFood (esgotar)</strong>
              <button type="button" onClick={carregarItensIfood} disabled={ifoodItensLoading || !ifoodCfg.merchant_id}
                style={{ padding: '6px 14px', borderRadius: 8, cursor: ifoodCfg.merchant_id ? 'pointer' : 'not-allowed',
                  border: '1.5px solid #ea1d2c', background: 'transparent', color: '#ea1d2c', fontWeight: 700, fontSize: 13, opacity: ifoodCfg.merchant_id ? 1 : 0.5 }}>
                {ifoodItensLoading ? 'Carregando...' : (ifoodItens ? '🔄 Atualizar lista' : 'Ver itens do iFood')}
              </button>
            </div>
            {ifoodItens && (
              ifoodItens.length === 0 ? (
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>Nenhum item no catálogo do iFood.</p>
              ) : (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 340, overflowY: 'auto' }}>
                  {ifoodItens.map(item => {
                    const pausado = item.status === 'UNAVAILABLE'
                    return (
                      <div key={item.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                        padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.nome}</div>
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                            {item.categoria}{item.preco ? ` · R$ ${Number(item.preco).toFixed(2)}` : ''}{pausado ? ' · ⏸ pausado' : ''}
                          </div>
                        </div>
                        <button type="button" onClick={() => pausarItemIfood(item, !pausado)} disabled={ifoodPausandoId === item.id}
                          style={{ flexShrink: 0, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 12.5,
                            border: `1.5px solid ${pausado ? '#16a34a' : '#f59e0b'}`, background: `${pausado ? '#16a34a' : '#f59e0b'}1e`, color: pausado ? '#16a34a' : '#b45309' }}>
                          {ifoodPausandoId === item.id ? '...' : (pausado ? '▶ Despausar' : '⏸ Pausar')}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            )}
            <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8, marginBottom: 0 }}>
              Pausar deixa o item indisponível no iFood na hora. (Precisa do módulo Catálogo homologado — em análise.)
            </p>
          </div>

          {/* Gerência completa de cardápio no iFood (criar/editar categoria, item, foto, complemento) */}
          <IfoodCatalogoManager empresaId={empresa?.id} merchantOk={!!ifoodCfg.merchant_id} />
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={ifoodCfg.auto_criar_produtos}
              onChange={e => setIfoodCfg(c => ({ ...c, auto_criar_produtos: e.target.checked }))}
              style={{ width: 16, height: 16, marginTop: 1, cursor: 'pointer', flexShrink: 0 }}
            />
            <span>
              Criar produtos automaticamente pelos pedidos
              <span style={{ color: 'var(--text-muted)' }}> — deixe <strong>desligado</strong> se sua loja já tem o cardápio cadastrado (evita itens duplicados).</span>
            </span>
          </label>
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
      </>
      )}

      {secao === 'fiscal' && (
      <>
      <form onSubmit={handleSalvarFiscal} style={{ marginTop: 16 }}>
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>Nota Fiscal (NFC-e)</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
            Preencha os dados fiscais da loja para poder emitir a NFC-e (cupom fiscal do
            consumidor) dos pedidos. A emissão é <strong>opcional e sob demanda</strong>: você
            escolhe em quais pedidos emitir — nada sai automático.
          </p>

          {fiscalMsg && (
            <div style={{
              background: fiscalMsg.tipo === 'ok' ? 'var(--success-bg)' : 'var(--danger-bg)',
              color: fiscalMsg.tipo === 'ok' ? 'var(--success)' : 'var(--danger)',
              border: `1px solid ${fiscalMsg.tipo === 'ok' ? 'var(--success)' : 'var(--danger)'}`,
              borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14,
            }}>
              {fiscalMsg.texto}
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={fiscalCfg.ativo}
              onChange={e => setFiscalCfg({ ...fiscalCfg, ativo: e.target.checked })}
              style={{ width: 18, height: 18 }}
            />
            <span style={{ fontSize: 14, fontWeight: 600 }}>Habilitar emissão de NFC-e nesta loja</span>
          </label>

          <div className="form-grid">
            <div className="form-field">
              <label>CNPJ</label>
              <input value={cnpj} disabled placeholder="Cadastre na aba Conta" style={{ opacity: 0.7 }} />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Editar em Minha Loja → Conta</span>
            </div>
            <div className="form-field">
              <label>Inscrição Estadual</label>
              <input
                value={fiscalCfg.inscricao_estadual}
                onChange={e => setFiscalCfg({ ...fiscalCfg, inscricao_estadual: e.target.value })}
                placeholder="Somente números"
              />
            </div>
            <div className="form-field">
              <label>Regime tributário</label>
              <select
                value={fiscalCfg.regime_tributario}
                onChange={e => setFiscalCfg({ ...fiscalCfg, regime_tributario: e.target.value })}
              >
                <option value="simples">Simples Nacional</option>
                <option value="simples_excesso">Simples Nacional - excesso de sublimite</option>
                <option value="normal">Regime Normal</option>
              </select>
            </div>
            <div className="form-field">
              <label>Ambiente</label>
              <select
                value={fiscalCfg.ambiente}
                onChange={e => setFiscalCfg({ ...fiscalCfg, ambiente: e.target.value })}
              >
                <option value="homologacao">Homologação (teste)</option>
                <option value="producao">Produção (nota válida)</option>
              </select>
            </div>
          </div>

          <h3 style={{ fontSize: 14, fontWeight: 700, margin: '20px 0 4px' }}>Segurança do contribuinte (CSC)</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
            O CSC e o ID do CSC são gerados no portal da SEFAZ do seu estado (menu de NFC-e).
          </p>
          <div className="form-grid">
            <div className="form-field">
              <label>ID do CSC</label>
              <input
                value={fiscalCfg.csc_id}
                onChange={e => setFiscalCfg({ ...fiscalCfg, csc_id: e.target.value })}
                placeholder="Ex: 000001"
              />
            </div>
            <div className="form-field">
              <label>Série da NFC-e</label>
              <input
                type="number" min={1}
                value={fiscalCfg.serie}
                onChange={e => setFiscalCfg({ ...fiscalCfg, serie: e.target.value })}
              />
            </div>
            <div className="form-field full">
              <label>Código CSC (token)</label>
              <input
                value={fiscalCfg.csc}
                onChange={e => setFiscalCfg({ ...fiscalCfg, csc: e.target.value })}
                placeholder="Token de segurança do contribuinte"
              />
            </div>
            <div className="form-field full">
              <label>Chave da API do emissor (PlugNotas) — opcional por enquanto</label>
              <input
                value={fiscalCfg.emissor_token}
                onChange={e => setFiscalCfg({ ...fiscalCfg, emissor_token: e.target.value })}
                placeholder="Preenchido quando a integração de emissão for ligada"
              />
            </div>
          </div>

          <h3 style={{ fontSize: 14, fontWeight: 700, margin: '20px 0 4px' }}>Classificação fiscal padrão dos produtos</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
            Aplicado a todos os produtos na hora de emitir. Os valores abaixo servem para a maioria
            das lojas de comida — só mude se seu contador orientar diferente.
          </p>
          <div className="form-grid">
            <div className="form-field">
              <label>NCM padrão</label>
              <input
                value={fiscalCfg.ncm_padrao}
                onChange={e => setFiscalCfg({ ...fiscalCfg, ncm_padrao: e.target.value })}
                placeholder="21069090"
              />
            </div>
            <div className="form-field">
              <label>CFOP padrão</label>
              <input
                value={fiscalCfg.cfop_padrao}
                onChange={e => setFiscalCfg({ ...fiscalCfg, cfop_padrao: e.target.value })}
                placeholder="5102"
              />
            </div>
            <div className="form-field">
              <label>CSOSN / CST padrão</label>
              <input
                value={fiscalCfg.csosn_padrao}
                onChange={e => setFiscalCfg({ ...fiscalCfg, csosn_padrao: e.target.value })}
                placeholder="102"
              />
            </div>
            <div className="form-field">
              <label>Origem da mercadoria</label>
              <select
                value={fiscalCfg.origem_padrao}
                onChange={e => setFiscalCfg({ ...fiscalCfg, origem_padrao: e.target.value })}
              >
                <option value="0">0 - Nacional</option>
                <option value="1">1 - Estrangeira (importação direta)</option>
                <option value="2">2 - Estrangeira (mercado interno)</option>
              </select>
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={fiscalSalvando} style={{ marginTop: 16 }}>
            {fiscalSalvando ? 'Salvando...' : 'Salvar dados fiscais'}
          </button>
        </div>
      </form>

      {/* Card do certificado A1 — o único passo manual pra loja emitir */}
      <form onSubmit={handleSubirCertificado}>
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>Certificado digital A1</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 14 }}>
            Suba o certificado <strong>A1 (.pfx)</strong> da loja e informe a senha. Depois disso a
            loja já fica pronta pra emitir NFC-e. A senha é usada só pra registrar no emissor e
            <strong> não fica salva</strong>.
          </p>

          {certNome && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13,
              background: certRegistrada ? 'var(--success-bg)' : 'var(--primary-bg)',
              color: certRegistrada ? 'var(--success)' : 'var(--text)',
              border: `1px solid ${certRegistrada ? 'var(--success)' : 'var(--primary)'}`,
            }}>
              {certRegistrada ? '✅' : '📄'} <strong>{certNome}</strong>
              {certRegistrada
                ? <span>· registrado no emissor — pronto pra emitir</span>
                : <span>· enviado, mas ainda não registrado no emissor</span>}
            </div>
          )}

          <div className="form-grid">
            <div className="form-field">
              <label>Arquivo do certificado (.pfx / .p12)</label>
              <input
                ref={certInputRef}
                type="file"
                accept=".pfx,.p12,application/x-pkcs12"
                onChange={e => setCertArquivo(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="form-field">
              <label>Senha do certificado</label>
              <input
                type="password"
                value={certSenha}
                onChange={e => setCertSenha(e.target.value)}
                placeholder="senha do arquivo .pfx"
                autoComplete="off"
              />
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={certEnviando} style={{ marginTop: 16 }}>
            {certEnviando ? 'Enviando e registrando...' : (certNome ? 'Trocar certificado e registrar' : 'Subir certificado e registrar')}
          </button>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10, marginBottom: 0 }}>
            Não tem o A1? Ele é comprado numa certificadora (ex.: Certisign, Serasa) — custa ~R$ 120–250/ano por CNPJ.
          </p>
        </div>
      </form>
      </>
      )}

      {secao === 'conta' && (
      <>
      {/* Card de dados do responsável / da empresa */}
      <form onSubmit={handleSalvarDados} style={{ marginTop: 16 }}>
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, marginTop: 0 }}>Dados do responsável</h2>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0, marginBottom: 16 }}>
            Dados de quem responde pela loja — usados para contato, suporte e nota fiscal.
          </p>

          {erroDados && (
            <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14 }}>
              {erroDados}
            </div>
          )}
          {sucessoDados && (
            <div style={{ background: 'var(--success-bg)', color: 'var(--success)', border: '1px solid var(--success)', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 14 }}>
              Dados salvos ✓
            </div>
          )}

          <div className="form-grid">
            <div className="form-field full">
              <label>Nome do responsável</label>
              <input type="text" value={nomeResponsavel} onChange={e => setNomeResponsavel(e.target.value)} placeholder="Nome de quem responde pela loja" autoComplete="name" />
            </div>
            <div className="form-field">
              <label>CPF / CNPJ</label>
              <input type="text" value={cnpj} onChange={e => setCnpj(e.target.value)} placeholder="Só números" inputMode="numeric" />
            </div>
            <div className="form-field">
              <label>Telefone / WhatsApp</label>
              <input type="tel" value={telefoneContato} onChange={e => setTelefoneContato(e.target.value)} placeholder="(00) 00000-0000" autoComplete="tel" />
            </div>
            <div className="form-field full">
              <label>E-mail de contato</label>
              <input type="email" value={emailContato} onChange={e => setEmailContato(e.target.value)} placeholder="contato@email.com" autoComplete="email" />
            </div>
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={salvandoDados} style={{ marginBottom: 16 }}>
          {salvandoDados ? 'Salvando...' : 'Salvar dados'}
        </button>
      </form>

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
      </>
      )}
    </div>
  )
}
