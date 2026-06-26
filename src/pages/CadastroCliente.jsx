import { useState, useEffect, useRef } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { supabase } from '../lib/supabaseClient'
import ThemeToggle from '../components/ThemeToggle'
import './Login.css'

const ESTADOS_BR = [
  { uf: 'AC', nome: 'Acre' },
  { uf: 'AL', nome: 'Alagoas' },
  { uf: 'AP', nome: 'Amapá' },
  { uf: 'AM', nome: 'Amazonas' },
  { uf: 'BA', nome: 'Bahia' },
  { uf: 'CE', nome: 'Ceará' },
  { uf: 'DF', nome: 'Distrito Federal' },
  { uf: 'ES', nome: 'Espírito Santo' },
  { uf: 'GO', nome: 'Goiás' },
  { uf: 'MA', nome: 'Maranhão' },
  { uf: 'MT', nome: 'Mato Grosso' },
  { uf: 'MS', nome: 'Mato Grosso do Sul' },
  { uf: 'MG', nome: 'Minas Gerais' },
  { uf: 'PA', nome: 'Pará' },
  { uf: 'PB', nome: 'Paraíba' },
  { uf: 'PR', nome: 'Paraná' },
  { uf: 'PE', nome: 'Pernambuco' },
  { uf: 'PI', nome: 'Piauí' },
  { uf: 'RJ', nome: 'Rio de Janeiro' },
  { uf: 'RN', nome: 'Rio Grande do Norte' },
  { uf: 'RS', nome: 'Rio Grande do Sul' },
  { uf: 'RO', nome: 'Rondônia' },
  { uf: 'RR', nome: 'Roraima' },
  { uf: 'SC', nome: 'Santa Catarina' },
  { uf: 'SP', nome: 'São Paulo' },
  { uf: 'SE', nome: 'Sergipe' },
  { uf: 'TO', nome: 'Tocantins' },
]

export default function CadastroCliente() {
  const { empresaId } = useParams()
  const [searchParams] = useSearchParams()
  const refToken = searchParams.get('ref') || ''
  const { session, signup } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()

  const [indicadorNome, setIndicadorNome] = useState(null)

  // patrocinador digitado manualmente (quando não tem ?ref= na URL)
  const [sponsorInput, setSponsorInput]   = useState('')
  const [sponsorStatus, setSponsorStatus] = useState(null) // null | 'checking' | 'found' | 'not_found'
  const [sponsorInfo, setSponsorInfo]     = useState(null) // { nome, ref_token }
  const [noSponsor, setNoSponsor]         = useState(false)
  const [rootRefToken, setRootRefToken]   = useState(null)
  const sponsorTimer = useRef(null)

  useEffect(() => {
    if (!refToken) return
    supabase.rpc('get_referrer_name', { p_token: refToken }).then(({ data }) => {
      if (data) setIndicadorNome(data)
    })
  }, [refToken])

  const [username, setUsername]           = useState('')
  const [usernameStatus, setUsernameStatus] = useState(null) // null | 'checking' | 'ok' | 'taken' | 'invalid'
  const usernameTimer = useRef(null)

  const [nome, setNome]                   = useState('')
  const [cpf, setCpf]                     = useState('')
  const [telefone, setTelefone]           = useState('')
  const [email, setEmail]                 = useState('')
  const [cep, setCep]                     = useState('')
  const [endereco, setEndereco]           = useState('')
  const [numero, setNumero]               = useState('')
  const [complemento, setComplemento]     = useState('')
  const [estado, setEstado]               = useState('')
  const [cidades, setCidades]             = useState([])
  const [loadingCidades, setLoadingCidades] = useState(false)
  const [cidade, setCidade]               = useState('')
  const [bairro, setBairro]               = useState('')
  const [password, setPassword]           = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [buscandoCep, setBuscandoCep]     = useState(false)
  const [erroCep, setErroCep]             = useState(null)
  const [error, setError]                 = useState(null)
  const [success, setSuccess]             = useState(null)
  const [loading, setLoading]             = useState(false)

  if (session) {
    return <Navigate to="/portal" replace />
  }

  function handleUsernameChange(e) {
    const raw = e.target.value.replace(/\s/g, '').toLowerCase()
    setUsername(raw)
    clearTimeout(usernameTimer.current)

    if (!raw) { setUsernameStatus(null); return }
    if (!/^[a-z0-9_.]{1,30}$/.test(raw)) {
      setUsernameStatus('invalid')
      return
    }
    if (raw.length < 3) { setUsernameStatus(null); return }

    setUsernameStatus('checking')
    usernameTimer.current = setTimeout(async () => {
      const { data } = await supabase.rpc('check_username_available', { p_username: raw })
      setUsernameStatus(data ? 'ok' : 'taken')
    }, 600)
  }

  function handleSponsorChange(e) {
    const raw = e.target.value.replace(/\s/g, '').toLowerCase()
    setSponsorInput(raw)
    setSponsorInfo(null)
    setNoSponsor(false)
    clearTimeout(sponsorTimer.current)
    if (!raw) { setSponsorStatus(null); return }
    setSponsorStatus('checking')
    sponsorTimer.current = setTimeout(async () => {
      const { data } = await supabase.rpc('get_referrer_info_by_username', { p_username: raw })
      if (data) { setSponsorStatus('found'); setSponsorInfo(data) }
      else setSponsorStatus('not_found')
    }, 600)
  }

  async function handleNoSponsor() {
    setNoSponsor(true)
    setSponsorInput('')
    setSponsorStatus(null)
    setSponsorInfo(null)
    if (!rootRefToken) {
      const { data } = await supabase.rpc('get_root_ref_token')
      setRootRefToken(data)
    }
  }

  function handleCpfChange(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 11)
    const fmt = v
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1-$2')
    setCpf(fmt)
  }

  function handleCepChange(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 8)
    const fmt = v.length > 5 ? `${v.slice(0, 5)}-${v.slice(5)}` : v
    setCep(fmt)
    setErroCep(null)
    if (v.length === 8) buscarCep(v)
  }

  async function carregarCidades(uf, cidadeParaSelecionar = '') {
    setLoadingCidades(true)
    try {
      const res = await fetch(
        `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`
      )
      const data = await res.json()
      const lista = data.map(c => c.nome)
      setCidades(lista)
      if (cidadeParaSelecionar) {
        const match = lista.find(c => c.toLowerCase() === cidadeParaSelecionar.toLowerCase())
        if (match) setCidade(match)
      }
    } catch {
      setCidades([])
    } finally {
      setLoadingCidades(false)
    }
  }

  async function buscarCep(numeros) {
    setBuscandoCep(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${numeros}/json/`)
      const data = await res.json()
      if (data.erro) { setErroCep('CEP não encontrado.'); return }
      setEndereco(data.logradouro || '')
      setBairro(data.bairro || '')
      if (data.uf) {
        setEstado(data.uf)
        await carregarCidades(data.uf, data.localidade || '')
      }
    } catch {
      setErroCep('Erro ao buscar CEP.')
    } finally {
      setBuscandoCep(false)
    }
  }

  async function handleEstadoChange(e) {
    const uf = e.target.value
    setEstado(uf)
    setCidade('')
    setCidades([])
    if (uf) await carregarCidades(uf)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    if (!username || username.length < 3) {
      setError('Escolha um apelido com pelo menos 3 caracteres.')
      return
    }
    if (!/^[a-z0-9_.]{3,30}$/.test(username)) {
      setError('Apelido: só letras, números, _ ou . sem espaço.')
      return
    }
    if (usernameStatus === 'taken') {
      setError('Este apelido já está em uso. Escolha outro.')
      return
    }
    if (password !== confirmPassword) {
      setError('As senhas não conferem.')
      return
    }
    if (password.length < 6) {
      setError('A senha precisa ter pelo menos 6 caracteres.')
      return
    }
    if (!endereco.trim()) { setError('Informe o nome da rua.'); return }
    if (!numero.trim()) { setError('Número da casa é obrigatório.'); return }
    if (!estado) { setError('Selecione o estado.'); return }
    if (!cidade) { setError('Selecione a cidade.'); return }
    if (!bairro.trim()) { setError('Bairro é obrigatório.'); return }

    // resolve ref token: URL > patrocinador digitado > conta raiz (sem patrocinador)
    let finalRefToken = refToken
    if (!finalRefToken && sponsorStatus === 'found' && sponsorInfo?.ref_token) {
      finalRefToken = sponsorInfo.ref_token
    } else if (!finalRefToken && noSponsor) {
      finalRefToken = rootRefToken || (await supabase.rpc('get_root_ref_token')).data
    }

    setLoading(true)
    const { error } = await signup(email, password, {
      nome,
      telefone,
      tipo_cadastro: 'cliente',
      empresa_id: empresaId,
      ref_by_token: finalRefToken || undefined,
      cpf:          cpf.replace(/\D/g, '') ? cpf : null,
      cep:          cep || null,
      endereco:     endereco || null,
      numero:       numero || null,
      complemento:  complemento || null,
      bairro:       bairro || null,
      cidade:       cidade || null,
      estado:       estado || null,
    })

    if (error) {
      setLoading(false)
      const msg = error.message ?? ''
      if (msg.toLowerCase().includes('already registered') || msg.toLowerCase().includes('already been registered')) {
        setError('Este e-mail já tem uma conta. Faça login ou recupere sua senha.')
      } else {
        setError(msg)
      }
      return
    }

    // Salva o apelido no profile (SECURITY DEFINER — funciona mesmo sem sessão ativa)
    await supabase.rpc('set_profile_username_on_signup', { p_email: email, p_username: username })
    setLoading(false)

    setSuccess(`Cadastro realizado! Entre com o apelido "${username}" e sua senha.`)
    setTimeout(() => navigate('/login?tipo=cliente'), 2500)
  }

  const selectStyle = {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--input-bg, var(--bg))',
    color: 'var(--text)',
    fontSize: 14,
    outline: 'none',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center',
    paddingRight: 32,
    cursor: 'pointer',
  }

  return (
    <div className="login-page">
      <div className="login-theme-toggle">
        <ThemeToggle theme={theme} onToggle={toggleTheme} />
      </div>

      <div className="login-card login-card--wide">
        <div className="login-brand">
          <span className="login-logo" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2h8" />
              <path d="M9 2v6.5a2 2 0 0 1-.4 1.2L4.6 16a3 3 0 0 0 2.4 5h10a3 3 0 0 0 2.4-5l-4-6.3A2 2 0 0 1 15 8.5V2" />
              <path d="M6 14h12" />
            </svg>
          </span>
          <div>
            <h1>Depósito CRM</h1>
            <p className="login-subtitle">Crie sua conta de cliente</p>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>

          {/* Banner de indicação via link */}
          {indicadorNome && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 4,
              background: 'rgba(134,59,255,.1)', border: '1px solid rgba(134,59,255,.3)',
              fontSize: 13, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              <span>Indicado por <strong>{indicadorNome}</strong> — você faz parte da rede de indicações!</span>
            </div>
          )}

          {/* Sem link: campo para digitar apelido do patrocinador */}
          {!refToken && !noSponsor && (
            <div style={{ marginBottom: 4 }}>
              <div className="form-field" style={{ marginBottom: 6 }}>
                <label htmlFor="sponsor" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Apelido do patrocinador</span>
                  {sponsorStatus === 'checking' && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Buscando...</span>
                  )}
                  {sponsorStatus === 'found' && (
                    <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 700 }}>✓ {sponsorInfo?.nome?.split(' ')[0]}</span>
                  )}
                  {sponsorStatus === 'not_found' && (
                    <span style={{ fontSize: 11, color: 'var(--danger)' }}>Apelido não encontrado</span>
                  )}
                </label>
                <input
                  id="sponsor"
                  type="text"
                  placeholder="ex: joaosilva"
                  value={sponsorInput}
                  onChange={handleSponsorChange}
                  maxLength={30}
                  style={{
                    borderColor: sponsorStatus === 'found' ? 'var(--success)'
                      : sponsorStatus === 'not_found' ? 'var(--danger)'
                      : undefined
                  }}
                />
              </div>
              <button
                type="button"
                onClick={handleNoSponsor}
                style={{
                  width: '100%', padding: '8px 0', borderRadius: 8,
                  border: '1.5px dashed var(--border)', background: 'transparent',
                  color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer',
                }}
              >
                Não tenho link nem patrocinador
              </button>
            </div>
          )}

          {/* Banner "sem patrocinador" confirmado */}
          {!refToken && noSponsor && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 4,
              background: 'rgba(100,100,100,.08)', border: '1px solid var(--border)',
              fontSize: 13, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span>Sem patrocinador — conta vinculada à rede principal.</span>
              <button
                type="button"
                onClick={() => setNoSponsor(false)}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12, cursor: 'pointer', padding: 0 }}
              >
                Alterar
              </button>
            </div>
          )}

          {/* Banner quando achou o patrocinador digitado */}
          {!refToken && sponsorStatus === 'found' && sponsorInfo && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, marginBottom: 4,
              background: 'rgba(134,59,255,.1)', border: '1px solid rgba(134,59,255,.3)',
              fontSize: 13, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              <span>Patrocinador: <strong>{sponsorInfo.nome}</strong></span>
            </div>
          )}

          {/* Apelido único */}
          <div className="form-field">
            <label htmlFor="username" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Apelido (login único) <span style={{ color: 'var(--danger)' }}>*</span></span>
              {usernameStatus === 'checking' && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Verificando...</span>
              )}
              {usernameStatus === 'ok' && (
                <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 700 }}>✓ Disponível</span>
              )}
              {usernameStatus === 'taken' && (
                <span style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 700 }}>✗ Já em uso</span>
              )}
              {usernameStatus === 'invalid' && (
                <span style={{ fontSize: 11, color: 'var(--danger)' }}>Sem espaços ou caracteres especiais</span>
              )}
            </label>
            <input
              id="username"
              type="text"
              placeholder="ex: joaosilva ou joao.silva2"
              value={username}
              onChange={handleUsernameChange}
              autoComplete="username"
              maxLength={30}
              required
              style={{
                borderColor: usernameStatus === 'ok' ? 'var(--success)'
                  : usernameStatus === 'taken' || usernameStatus === 'invalid' ? 'var(--danger)'
                  : undefined
              }}
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Letras, números, _ ou . sem espaço. Será usado para entrar.
            </span>
          </div>

          {/* Nome */}
          <div className="form-field">
            <label htmlFor="nome">Nome</label>
            <input id="nome" type="text" placeholder="Seu nome" value={nome}
              onChange={(e) => setNome(e.target.value)} autoComplete="name" required />
          </div>

          {/* CPF */}
          <div className="form-field">
            <label htmlFor="cpf">
              CPF <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opcional)</span>
            </label>
            <input id="cpf" type="text" placeholder="000.000.000-00" value={cpf}
              onChange={handleCpfChange} inputMode="numeric" maxLength={14} />
          </div>

          {/* WhatsApp / Telefone */}
          <div className="form-field">
            <label htmlFor="telefone">WhatsApp / Telefone</label>
            <input id="telefone" type="tel" placeholder="(84) 99999-9999" value={telefone}
              onChange={(e) => setTelefone(e.target.value)} autoComplete="tel" required />
          </div>

          {/* E-mail */}
          <div className="form-field">
            <label htmlFor="email">E-mail</label>
            <input id="email" type="email" placeholder="voce@exemplo.com" value={email}
              onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </div>

          {/* Separador de endereço */}
          <p style={{ margin: '8px 0 0', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            Endereço de entrega
          </p>

          {/* CEP — opcional, preenche automático */}
          <div className="form-field" style={{ position: 'relative' }}>
            <label htmlFor="cep">
              CEP <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opcional — preenche o endereço automaticamente)</span>
            </label>
            <input id="cep" type="text" placeholder="00000-000" value={cep}
              onChange={handleCepChange} inputMode="numeric" maxLength={9} autoComplete="postal-code" />
            {buscandoCep && (
              <span style={{ position: 'absolute', right: 10, top: 34, fontSize: 12, color: 'var(--text-muted)' }}>
                Buscando...
              </span>
            )}
            {erroCep && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{erroCep}</span>}
          </div>

          {/* Rua */}
          <div className="form-field">
            <label htmlFor="endereco">Rua / Av. <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input id="endereco" type="text" placeholder="Rua das Flores" value={endereco}
              onChange={(e) => setEndereco(e.target.value)} autoComplete="street-address" />
          </div>

          {/* Número + Complemento */}
          <div className="addr-row addr-row--num-comp">
            <div className="form-field">
              <label htmlFor="numero">Número <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input id="numero" type="text" placeholder="123" value={numero}
                onChange={(e) => setNumero(e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="complemento">
                Complemento <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opc.)</span>
              </label>
              <input id="complemento" type="text" placeholder="Apto 4" value={complemento}
                onChange={(e) => setComplemento(e.target.value)} />
            </div>
          </div>

          {/* Estado + Cidade na mesma linha */}
          <div className="addr-row addr-row--estado-cidade">
            <div className="form-field">
              <label htmlFor="estado">Estado <span style={{ color: 'var(--danger)' }}>*</span></label>
              <select id="estado" value={estado} onChange={handleEstadoChange} style={selectStyle}>
                <option value="">UF</option>
                {ESTADOS_BR.map(({ uf, nome: n }) => (
                  <option key={uf} value={uf}>{uf} — {n}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="cidade">Cidade <span style={{ color: 'var(--danger)' }}>*</span></label>
              <select id="cidade" value={cidade} onChange={(e) => setCidade(e.target.value)}
                disabled={!estado || loadingCidades} style={{ ...selectStyle, opacity: (!estado || loadingCidades) ? 0.6 : 1 }}>
                <option value="">
                  {loadingCidades ? 'Carregando...' : estado ? 'Selecione' : 'Selecione o estado'}
                </option>
                {cidades.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {/* Bairro */}
          <div className="form-field">
            <label htmlFor="bairro">Bairro <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input id="bairro" type="text" placeholder="Centro" value={bairro}
              onChange={(e) => setBairro(e.target.value)} />
          </div>

          {/* Senha */}
          <div className="form-field" style={{ marginTop: 8 }}>
            <label htmlFor="password">Senha</label>
            <input id="password" type="password" placeholder="••••••••" value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          </div>

          {/* Confirmar senha */}
          <div className="form-field">
            <label htmlFor="confirm-password">Confirmar senha</label>
            <input id="confirm-password" type="password" placeholder="••••••••" value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
          </div>

          {error && (
            <div className="login-error" role="alert">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="login-error" role="status" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
              <span>{success}</span>
            </div>
          )}

          <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.6, margin: '4px 0' }}>
            Ao criar sua conta, você concorda com os{' '}
            <Link to="/termos" target="_blank" style={{ color: 'var(--primary)' }}>Termos de Uso</Link>
            {' '}e a{' '}
            <Link to="/privacidade" target="_blank" style={{ color: 'var(--primary)' }}>Política de Privacidade</Link>
            {' '}da plataforma.
          </p>

          <button type="submit" className="btn btn-primary login-submit" disabled={loading}>
            {loading ? (
              <>
                <span className="login-spinner" aria-hidden="true" />
                Cadastrando...
              </>
            ) : (
              'Criar conta'
            )}
          </button>

          <p className="login-links">
            Já tem conta? <Link to="/login?tipo=cliente">Entrar</Link>
          </p>
        </form>
      </div>
    </div>
  )
}
