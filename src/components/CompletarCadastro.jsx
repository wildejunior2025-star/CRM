import { useState, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../pages/Login.css'

const ESTADOS_BR = [
  { uf: 'AC', nome: 'Acre' }, { uf: 'AL', nome: 'Alagoas' }, { uf: 'AP', nome: 'Amapá' },
  { uf: 'AM', nome: 'Amazonas' }, { uf: 'BA', nome: 'Bahia' }, { uf: 'CE', nome: 'Ceará' },
  { uf: 'DF', nome: 'Distrito Federal' }, { uf: 'ES', nome: 'Espírito Santo' }, { uf: 'GO', nome: 'Goiás' },
  { uf: 'MA', nome: 'Maranhão' }, { uf: 'MT', nome: 'Mato Grosso' }, { uf: 'MS', nome: 'Mato Grosso do Sul' },
  { uf: 'MG', nome: 'Minas Gerais' }, { uf: 'PA', nome: 'Pará' }, { uf: 'PB', nome: 'Paraíba' },
  { uf: 'PR', nome: 'Paraná' }, { uf: 'PE', nome: 'Pernambuco' }, { uf: 'PI', nome: 'Piauí' },
  { uf: 'RJ', nome: 'Rio de Janeiro' }, { uf: 'RN', nome: 'Rio Grande do Norte' }, { uf: 'RS', nome: 'Rio Grande do Sul' },
  { uf: 'RO', nome: 'Rondônia' }, { uf: 'RR', nome: 'Roraima' }, { uf: 'SC', nome: 'Santa Catarina' },
  { uf: 'SP', nome: 'São Paulo' }, { uf: 'SE', nome: 'Sergipe' }, { uf: 'TO', nome: 'Tocantins' },
]

export default function CompletarCadastro({ onConcluido }) {
  const { user, profile, refreshProfile, logout } = useAuth()

  const emailGoogle = user?.email ?? ''
  const nomeGoogle = user?.user_metadata?.full_name || user?.user_metadata?.name || ''
  const nomeInicial = (profile?.nome && profile.nome !== profile.email) ? profile.nome : nomeGoogle

  // Dados
  const [nome, setNome]           = useState(nomeInicial)
  const [username, setUsername]   = useState('')
  const [usernameStatus, setUsernameStatus] = useState(null) // null | checking | ok | taken | invalid
  const usernameTimer = useRef(null)
  const [password, setPassword]   = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [telefone, setTelefone]   = useState('')
  const [cep, setCep]             = useState('')
  const [endereco, setEndereco]   = useState('')
  const [numero, setNumero]       = useState('')
  const [complemento, setComplemento] = useState('')
  const [estado, setEstado]       = useState('')
  const [cidades, setCidades]     = useState([])
  const [loadingCidades, setLoadingCidades] = useState(false)
  const [cidade, setCidade]       = useState('')
  const [bairro, setBairro]       = useState('')
  const [buscandoCep, setBuscandoCep] = useState(false)
  const [erroCep, setErroCep]     = useState(null)

  // Patrocinador
  const [sponsorInput, setSponsorInput]   = useState('')
  const [sponsorStatus, setSponsorStatus] = useState(null) // null | checking | found | not_found
  const [sponsorInfo, setSponsorInfo]     = useState(null) // { nome, ref_token }
  const [noSponsor, setNoSponsor]         = useState(false)
  const sponsorTimer = useRef(null)

  const [error, setError]   = useState(null)
  const [loading, setLoading] = useState(false)

  function handleUsernameChange(e) {
    const raw = e.target.value.replace(/\s/g, '').toLowerCase()
    setUsername(raw)
    clearTimeout(usernameTimer.current)
    if (!raw) { setUsernameStatus(null); return }
    if (!/^[a-z0-9_.]{1,30}$/.test(raw)) { setUsernameStatus('invalid'); return }
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

  function handleCepChange(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 8)
    setCep(v.length > 5 ? `${v.slice(0, 5)}-${v.slice(5)}` : v)
    setErroCep(null)
    if (v.length === 8) buscarCep(v)
  }

  async function carregarCidades(uf, cidadeParaSelecionar = '') {
    setLoadingCidades(true)
    try {
      const res = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`)
      const data = await res.json()
      const lista = data.map(c => c.nome)
      setCidades(lista)
      if (cidadeParaSelecionar) {
        const match = lista.find(c => c.toLowerCase() === cidadeParaSelecionar.toLowerCase())
        if (match) setCidade(match)
      }
    } catch { setCidades([]) } finally { setLoadingCidades(false) }
  }

  async function buscarCep(numeros) {
    setBuscandoCep(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${numeros}/json/`)
      const data = await res.json()
      if (data.erro) { setErroCep('CEP não encontrado.'); return }
      setEndereco(data.logradouro || '')
      setBairro(data.bairro || '')
      if (data.uf) { setEstado(data.uf); await carregarCidades(data.uf, data.localidade || '') }
    } catch { setErroCep('Erro ao buscar CEP.') } finally { setBuscandoCep(false) }
  }

  async function handleEstadoChange(e) {
    const uf = e.target.value
    setEstado(uf); setCidade(''); setCidades([])
    if (uf) await carregarCidades(uf)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (!nome.trim()) { setError('Informe seu nome.'); return }
    if (!username || username.length < 3) { setError('Escolha um apelido com pelo menos 3 caracteres.'); return }
    if (!/^[a-z0-9_.]{3,30}$/.test(username)) { setError('Apelido: só letras, números, _ ou . sem espaço.'); return }
    if (usernameStatus === 'taken') { setError('Este apelido já está em uso. Escolha outro.'); return }
    if (password.length < 6) { setError('A senha precisa ter pelo menos 6 caracteres.'); return }
    if (password !== confirmPassword) { setError('As senhas não conferem.'); return }
    if (!telefone.trim()) { setError('Telefone é obrigatório.'); return }
    if (!endereco.trim()) { setError('Informe o nome da rua.'); return }
    if (!numero.trim()) { setError('Número da casa é obrigatório.'); return }
    if (!estado) { setError('Selecione o estado.'); return }
    if (!cidade) { setError('Selecione a cidade.'); return }
    if (!bairro.trim()) { setError('Bairro é obrigatório.'); return }
    if (!noSponsor && sponsorStatus !== 'found') {
      setError('Informe o apelido do seu patrocinador ou marque "Não tenho patrocinador".')
      return
    }

    setLoading(true)

    // 1) Define a senha na conta (que veio sem senha pelo Google)
    const { error: pwErr } = await supabase.auth.updateUser({ password })
    if (pwErr) { setLoading(false); setError(pwErr.message); return }

    // 2) Salva apelido, telefone, endereço e patrocinador (vazio => raiz)
    const refToken = noSponsor ? '' : (sponsorInfo?.ref_token ?? '')
    const { error: rpcErr } = await supabase.rpc('completar_cadastro_google', {
      p_username:    username,
      p_nome:        nome.trim(),
      p_telefone:    telefone.trim(),
      p_cep:         cep,
      p_endereco:    endereco.trim(),
      p_numero:      numero.trim(),
      p_complemento: complemento.trim(),
      p_bairro:      bairro.trim(),
      p_cidade:      cidade,
      p_estado:      estado,
      p_ref_token:   refToken,
    })
    setLoading(false)
    if (rpcErr) { setError(rpcErr.message); return }

    await refreshProfile()
    onConcluido?.()
  }

  const selectStyle = {
    width: '100%', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8,
    background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14, outline: 'none',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', paddingRight: 32, cursor: 'pointer',
  }

  return (
    <div className="login-page">
      <div className="login-card login-card--wide">
        <div className="login-brand">
          <span className="login-logo" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <div>
            <h1>Complete seu cadastro</h1>
            <p className="login-subtitle">Falta pouco para usar o app{emailGoogle ? ` (${emailGoogle})` : ''}</p>
          </div>
        </div>

        <form className="login-form" onSubmit={handleSubmit}>
          {/* Nome */}
          <div className="form-field">
            <label htmlFor="cc-nome">Nome <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input id="cc-nome" type="text" placeholder="Seu nome completo" value={nome}
              onChange={e => setNome(e.target.value)} autoComplete="name" required />
          </div>

          {/* Apelido */}
          <div className="form-field">
            <label htmlFor="cc-username" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Apelido (login único) <span style={{ color: 'var(--danger)' }}>*</span></span>
              {usernameStatus === 'checking' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Verificando...</span>}
              {usernameStatus === 'ok' && <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 700 }}>✓ Disponível</span>}
              {usernameStatus === 'taken' && <span style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 700 }}>✗ Já em uso</span>}
              {usernameStatus === 'invalid' && <span style={{ fontSize: 11, color: 'var(--danger)' }}>Sem espaços/especiais</span>}
            </label>
            <input id="cc-username" type="text" placeholder="ex: joaosilva" value={username}
              onChange={handleUsernameChange} autoComplete="username" maxLength={30} required
              style={{ borderColor: usernameStatus === 'ok' ? 'var(--success)' : (usernameStatus === 'taken' || usernameStatus === 'invalid') ? 'var(--danger)' : undefined }} />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Você poderá entrar com apelido + senha.</span>
          </div>

          {/* Senha + Confirmar */}
          <div className="form-field">
            <label htmlFor="cc-pass">Senha <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input id="cc-pass" type="password" placeholder="••••••••" value={password}
              onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />
          </div>
          <div className="form-field">
            <label htmlFor="cc-pass2">Confirmar senha <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input id="cc-pass2" type="password" placeholder="••••••••" value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
          </div>

          {/* Telefone */}
          <div className="form-field">
            <label htmlFor="cc-tel">WhatsApp / Telefone <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input id="cc-tel" type="tel" placeholder="(84) 99999-9999" value={telefone}
              onChange={e => setTelefone(e.target.value)} autoComplete="tel" required />
          </div>

          {/* Endereço */}
          <p style={{ margin: '8px 0 0', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Endereço</p>

          <div className="form-field" style={{ position: 'relative' }}>
            <label htmlFor="cc-cep">CEP <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opcional — preenche automático)</span></label>
            <input id="cc-cep" type="text" placeholder="00000-000" value={cep}
              onChange={handleCepChange} inputMode="numeric" maxLength={9} autoComplete="postal-code" />
            {buscandoCep && <span style={{ position: 'absolute', right: 10, top: 34, fontSize: 12, color: 'var(--text-muted)' }}>Buscando...</span>}
            {erroCep && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{erroCep}</span>}
          </div>

          <div className="form-field">
            <label htmlFor="cc-rua">Rua / Av. <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input id="cc-rua" type="text" placeholder="Rua das Flores" value={endereco}
              onChange={e => setEndereco(e.target.value)} autoComplete="street-address" />
          </div>

          <div className="addr-row addr-row--num-comp">
            <div className="form-field">
              <label htmlFor="cc-num">Número <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input id="cc-num" type="text" placeholder="123" value={numero} onChange={e => setNumero(e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="cc-comp">Complemento <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opc.)</span></label>
              <input id="cc-comp" type="text" placeholder="Apto 4" value={complemento} onChange={e => setComplemento(e.target.value)} />
            </div>
          </div>

          <div className="addr-row addr-row--estado-cidade">
            <div className="form-field">
              <label htmlFor="cc-uf">Estado <span style={{ color: 'var(--danger)' }}>*</span></label>
              <select id="cc-uf" value={estado} onChange={handleEstadoChange} style={selectStyle}>
                <option value="">UF</option>
                {ESTADOS_BR.map(({ uf, nome: n }) => <option key={uf} value={uf}>{uf} — {n}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="cc-cid">Cidade <span style={{ color: 'var(--danger)' }}>*</span></label>
              <select id="cc-cid" value={cidade} onChange={e => setCidade(e.target.value)}
                disabled={!estado || loadingCidades} style={{ ...selectStyle, opacity: (!estado || loadingCidades) ? 0.6 : 1 }}>
                <option value="">{loadingCidades ? 'Carregando...' : estado ? 'Selecione' : 'Selecione o estado'}</option>
                {cidades.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="cc-bairro">Bairro <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input id="cc-bairro" type="text" placeholder="Centro" value={bairro} onChange={e => setBairro(e.target.value)} />
          </div>

          {/* Patrocinador */}
          <p style={{ margin: '8px 0 0', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Patrocinador</p>

          <div className="form-field">
            <label htmlFor="cc-sponsor" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Apelido do patrocinador</span>
              {sponsorStatus === 'checking' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Buscando...</span>}
              {sponsorStatus === 'found' && <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 700 }}>✓ {sponsorInfo?.nome?.split(' ')[0]}</span>}
              {sponsorStatus === 'not_found' && <span style={{ fontSize: 11, color: 'var(--danger)' }}>Não encontrado</span>}
            </label>
            <input id="cc-sponsor" type="text" placeholder="ex: joaosilva" value={sponsorInput}
              onChange={handleSponsorChange} maxLength={30} disabled={noSponsor}
              style={{ opacity: noSponsor ? 0.5 : 1, borderColor: sponsorStatus === 'found' ? 'var(--success)' : sponsorStatus === 'not_found' ? 'var(--danger)' : undefined }} />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer', marginTop: -4 }}>
            <input type="checkbox" checked={noSponsor}
              onChange={e => { setNoSponsor(e.target.checked); if (e.target.checked) { setSponsorInput(''); setSponsorStatus(null); setSponsorInfo(null) } }} />
            Não tenho patrocinador (entrar na rede principal)
          </label>

          {error && (
            <div className="login-error" role="alert">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary login-submit" disabled={loading}>
            {loading ? <><span className="login-spinner" aria-hidden="true" />Salvando...</> : 'Concluir cadastro'}
          </button>

          <button type="button" className="login-back-btn" style={{ alignSelf: 'center', marginTop: 4 }} onClick={logout}>
            Sair
          </button>
        </form>
      </div>
    </div>
  )
}
