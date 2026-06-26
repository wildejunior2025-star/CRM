import { useState, useEffect, useRef } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { supabase } from '../lib/supabaseClient'
import ThemeToggle from '../components/ThemeToggle'
import './Login.css'

const ESTADOS_BR = [
  { uf: 'AC', nome: 'Acre' }, { uf: 'AL', nome: 'Alagoas' }, { uf: 'AP', nome: 'Amapá' },
  { uf: 'AM', nome: 'Amazonas' }, { uf: 'BA', nome: 'Bahia' }, { uf: 'CE', nome: 'Ceará' },
  { uf: 'DF', nome: 'Distrito Federal' }, { uf: 'ES', nome: 'Espírito Santo' },
  { uf: 'GO', nome: 'Goiás' }, { uf: 'MA', nome: 'Maranhão' }, { uf: 'MT', nome: 'Mato Grosso' },
  { uf: 'MS', nome: 'Mato Grosso do Sul' }, { uf: 'MG', nome: 'Minas Gerais' },
  { uf: 'PA', nome: 'Pará' }, { uf: 'PB', nome: 'Paraíba' }, { uf: 'PR', nome: 'Paraná' },
  { uf: 'PE', nome: 'Pernambuco' }, { uf: 'PI', nome: 'Piauí' },
  { uf: 'RJ', nome: 'Rio de Janeiro' }, { uf: 'RN', nome: 'Rio Grande do Norte' },
  { uf: 'RS', nome: 'Rio Grande do Sul' }, { uf: 'RO', nome: 'Rondônia' },
  { uf: 'RR', nome: 'Roraima' }, { uf: 'SC', nome: 'Santa Catarina' },
  { uf: 'SP', nome: 'São Paulo' }, { uf: 'SE', nome: 'Sergipe' }, { uf: 'TO', nome: 'Tocantins' },
]

export default function CadastroRef() {
  const [searchParams] = useSearchParams()
  const refToken = searchParams.get('ref') || ''
  const { session, signup } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()

  const [tela, setTela] = useState('escolha') // 'escolha' | 'cliente' | 'loja'
  const [indicadorNome, setIndicadorNome] = useState(null)

  // ── Form loja ──────────────────────────────────────────────────────────────
  const [nomeLoja, setNomeLoja]         = useState('')
  const [nomeResp, setNomeResp]         = useState('')
  const [emailLoja, setEmailLoja]       = useState('')
  const [telLoja, setTelLoja]           = useState('')
  const [cnpjLoja, setCnpjLoja]         = useState('')
  const [razaoLoja, setRazaoLoja]       = useState('')

  // Endereço completo
  const [cep, setCep]             = useState('')
  const [rua, setRua]             = useState('')
  const [numero, setNumero]       = useState('')
  const [complemento, setComplemento] = useState('')
  const [bairro, setBairro]       = useState('')
  const [estado, setEstado]       = useState('')
  const [cidade, setCidade]       = useState('')
  const [cidades, setCidades]     = useState([])
  const [loadingCidades, setLoadingCidades] = useState(false)
  const [buscandoCep, setBuscandoCep] = useState(false)
  const [erroCep, setErroCep]     = useState(null)

  const [passLoja, setPassLoja]   = useState('')
  const [passLoja2, setPassLoja2] = useState('')
  const [lojaError, setLojaError] = useState(null)
  const [lojaSuccess, setLojaSuccess] = useState(null)
  const [lojaLoading, setLojaLoading] = useState(false)

  useEffect(() => {
    if (!refToken) return
    supabase.rpc('get_referrer_name', { p_token: refToken }).then(({ data }) => {
      if (data) setIndicadorNome(data)
    })
  }, [refToken])

  if (session) return <Navigate to="/portal" replace />
  if (tela === 'cliente') {
    return <Navigate to={`/cadastro-cliente${refToken ? `?ref=${refToken}` : ''}`} replace />
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function formatCnpj(v) {
    return v.replace(/\D/g, '')
      .replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d)/, '$1-$2')
      .slice(0, 18)
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
      const res = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`)
      const data = await res.json()
      const lista = data.map(c => c.nome)
      setCidades(lista)
      if (cidadeParaSelecionar) {
        const match = lista.find(c => c.toLowerCase() === cidadeParaSelecionar.toLowerCase())
        if (match) setCidade(match)
      }
    } catch { setCidades([]) }
    finally { setLoadingCidades(false) }
  }

  async function buscarCep(nums) {
    setBuscandoCep(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${nums}/json/`)
      const data = await res.json()
      if (data.erro) { setErroCep('CEP não encontrado.'); return }
      setRua(data.logradouro || '')
      setBairro(data.bairro || '')
      if (data.uf) {
        setEstado(data.uf)
        await carregarCidades(data.uf, data.localidade || '')
      }
    } catch { setErroCep('Erro ao buscar CEP.') }
    finally { setBuscandoCep(false) }
  }

  async function handleEstadoChange(e) {
    const uf = e.target.value
    setEstado(uf)
    setCidade('')
    setCidades([])
    if (uf) await carregarCidades(uf)
  }

  // ── Submit loja ────────────────────────────────────────────────────────────
  async function handleLojaSubmit(e) {
    e.preventDefault()
    setLojaError(null)
    setLojaSuccess(null)

    if (!nomeLoja.trim()) { setLojaError('Informe o nome da loja.'); return }
    if (!nomeResp.trim()) { setLojaError('Informe o seu nome.'); return }
    if (passLoja !== passLoja2) { setLojaError('As senhas não conferem.'); return }
    if (passLoja.length < 6) { setLojaError('A senha precisa ter pelo menos 6 caracteres.'); return }

    // Monta string de endereço completo para o campo "endereco" da empresa
    const enderecoCompleto = [rua, numero, complemento, bairro, cidade, estado, cep]
      .filter(Boolean).join(', ')

    setLojaLoading(true)
    const { error } = await signup(emailLoja, passLoja, {
      nome:                nomeResp.trim(),
      nome_empresa:        nomeLoja.trim(),
      tipo_cadastro:       'empresa',
      telefone:            telLoja || undefined,
      cnpj:                cnpjLoja || undefined,
      razao_social:        razaoLoja || undefined,
      endereco:            enderecoCompleto || undefined,
      ref_token_indicador: refToken || undefined,
    })
    setLojaLoading(false)

    if (error) {
      const msg = error.message ?? ''
      if (msg.toLowerCase().includes('already registered') || msg.toLowerCase().includes('already been registered')) {
        setLojaError('Este e-mail já tem uma conta. Faça login ou recupere sua senha.')
      } else {
        setLojaError(msg)
      }
      return
    }

    setLojaSuccess('Loja criada! Verifique seu e-mail para confirmar e depois faça login.')
    setTimeout(() => navigate('/login'), 3000)
  }

  const selectStyle = {
    width: '100%', padding: '10px 12px',
    border: '1px solid var(--border)', borderRadius: 8,
    background: 'var(--input-bg, var(--bg))', color: 'var(--text)',
    fontSize: 14, outline: 'none', appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center',
    paddingRight: 32, cursor: 'pointer',
  }

  // ── Render ─────────────────────────────────────────────────────────────────
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
            <p className="login-subtitle">
              {indicadorNome ? `Convite de ${indicadorNome}` : 'Bem-vindo!'}
            </p>
          </div>
        </div>

        {indicadorNome && (
          <div style={{
            padding: '10px 14px', borderRadius: 8, marginBottom: 20,
            background: 'rgba(134,59,255,.1)', border: '1px solid rgba(134,59,255,.3)',
            fontSize: 13, color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <span>Indicado por <strong>{indicadorNome}</strong></span>
          </div>
        )}

        {/* ── TELA ESCOLHA ───────────────────────────────────────────────────── */}
        {tela === 'escolha' && (
          <div>
            <p style={{ textAlign: 'center', fontSize: 15, fontWeight: 600, marginBottom: 24, color: 'var(--text)' }}>
              Como você quer entrar na plataforma?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <button type="button" onClick={() => setTela('cliente')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 16, padding: '18px 20px',
                  borderRadius: 12, cursor: 'pointer', border: '2px solid var(--border)',
                  background: 'var(--card-bg, var(--bg))', textAlign: 'left',
                  transition: 'border-color 150ms, box-shadow 150ms',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(134,59,255,.12)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = '' }}
              >
                <span style={{ fontSize: 32, lineHeight: 1 }}>👤</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', marginBottom: 2 }}>Sou cliente</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Quero comprar nas lojas da rede e acompanhar meus pedidos
                  </div>
                </div>
              </button>

              <button type="button" onClick={() => setTela('loja')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 16, padding: '18px 20px',
                  borderRadius: 12, cursor: 'pointer', border: '2px solid var(--border)',
                  background: 'var(--card-bg, var(--bg))', textAlign: 'left',
                  transition: 'border-color 150ms, box-shadow 150ms',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#f97316'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(249,115,22,.12)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = '' }}
              >
                <span style={{ fontSize: 32, lineHeight: 1 }}>🏪</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', marginBottom: 2 }}>Quero abrir minha loja</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Cadastrar meu negócio e vender pelo aplicativo
                  </div>
                </div>
              </button>
            </div>
            <p className="login-footer" style={{ marginTop: 24 }}>
              Já tem conta? <Link to="/login">Entrar</Link>
            </p>
          </div>
        )}

        {/* ── TELA LOJA ──────────────────────────────────────────────────────── */}
        {tela === 'loja' && (
          <form className="login-form" onSubmit={handleLojaSubmit}>

            <button type="button" onClick={() => setTela('escolha')}
              style={{
                background: 'none', border: 'none', color: 'var(--text-muted)',
                fontSize: 13, cursor: 'pointer', padding: '0 0 12px',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              ← Voltar
            </button>

            <p style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, color: 'var(--text)' }}>
              Cadastro da loja
            </p>

            {/* ─ Dados da loja ─ */}
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '8px 0 8px' }}>
              Dados da loja
            </div>

            <div className="form-field">
              <label htmlFor="nome-loja">Nome da loja <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input id="nome-loja" type="text" placeholder="Ex: Mercadinho do João"
                value={nomeLoja} onChange={e => setNomeLoja(e.target.value)} required autoFocus />
            </div>

            <div className="form-field">
              <label htmlFor="razao-loja">
                Razão social <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opcional)</span>
              </label>
              <input id="razao-loja" type="text" placeholder="Nome jurídico da empresa"
                value={razaoLoja} onChange={e => setRazaoLoja(e.target.value)} />
            </div>

            <div className="form-field">
              <label htmlFor="cnpj-loja">
                CNPJ <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opcional)</span>
              </label>
              <input id="cnpj-loja" type="text" placeholder="00.000.000/0000-00"
                value={cnpjLoja} onChange={e => setCnpjLoja(formatCnpj(e.target.value))}
                maxLength={18} inputMode="numeric" />
            </div>

            {/* ─ Endereço ─ */}
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '14px 0 8px' }}>
              Endereço da loja
            </div>

            <div className="form-field" style={{ position: 'relative' }}>
              <label htmlFor="cep-loja">
                CEP <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(preenche automático)</span>
              </label>
              <input id="cep-loja" type="text" placeholder="00000-000"
                value={cep} onChange={handleCepChange}
                inputMode="numeric" maxLength={9} autoComplete="postal-code" />
              {buscandoCep && (
                <span style={{ position: 'absolute', right: 10, top: 34, fontSize: 12, color: 'var(--text-muted)' }}>
                  Buscando...
                </span>
              )}
              {erroCep && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{erroCep}</span>}
            </div>

            <div className="form-field">
              <label htmlFor="rua-loja">Rua / Av.</label>
              <input id="rua-loja" type="text" placeholder="Rua das Flores"
                value={rua} onChange={e => setRua(e.target.value)} autoComplete="street-address" />
            </div>

            <div className="addr-row addr-row--num-comp">
              <div className="form-field">
                <label htmlFor="num-loja">Número</label>
                <input id="num-loja" type="text" placeholder="123"
                  value={numero} onChange={e => setNumero(e.target.value)} />
              </div>
              <div className="form-field">
                <label htmlFor="comp-loja">
                  Complemento <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opc.)</span>
                </label>
                <input id="comp-loja" type="text" placeholder="Sala 2"
                  value={complemento} onChange={e => setComplemento(e.target.value)} />
              </div>
            </div>

            <div className="addr-row addr-row--estado-cidade">
              <div className="form-field">
                <label htmlFor="estado-loja">Estado</label>
                <select id="estado-loja" value={estado} onChange={handleEstadoChange} style={selectStyle}>
                  <option value="">UF</option>
                  {ESTADOS_BR.map(({ uf, nome: n }) => (
                    <option key={uf} value={uf}>{uf} — {n}</option>
                  ))}
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="cidade-loja">Cidade</label>
                <select id="cidade-loja" value={cidade} onChange={e => setCidade(e.target.value)}
                  disabled={!estado || loadingCidades}
                  style={{ ...selectStyle, opacity: (!estado || loadingCidades) ? 0.6 : 1 }}>
                  <option value="">
                    {loadingCidades ? 'Carregando...' : estado ? 'Selecione' : 'Selecione o estado'}
                  </option>
                  {cidades.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="bairro-loja">Bairro</label>
              <input id="bairro-loja" type="text" placeholder="Centro"
                value={bairro} onChange={e => setBairro(e.target.value)} />
            </div>

            {/* ─ Acesso ─ */}
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '14px 0 8px' }}>
              Dados de acesso
            </div>

            <div className="form-field">
              <label htmlFor="nome-resp">Seu nome <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input id="nome-resp" type="text" placeholder="Nome do responsável"
                value={nomeResp} onChange={e => setNomeResp(e.target.value)} autoComplete="name" required />
            </div>

            <div className="form-field">
              <label htmlFor="email-loja">E-mail <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input id="email-loja" type="email" placeholder="voce@exemplo.com"
                value={emailLoja} onChange={e => setEmailLoja(e.target.value)} autoComplete="email" required />
            </div>

            <div className="form-field">
              <label htmlFor="tel-loja">
                WhatsApp / Telefone <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opcional)</span>
              </label>
              <input id="tel-loja" type="tel" placeholder="(84) 99999-9999"
                value={telLoja} onChange={e => setTelLoja(e.target.value)} autoComplete="tel" />
            </div>

            <div className="form-field">
              <label htmlFor="pass-loja">Senha <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input id="pass-loja" type="password" placeholder="••••••••"
                value={passLoja} onChange={e => setPassLoja(e.target.value)} autoComplete="new-password" required />
            </div>

            <div className="form-field">
              <label htmlFor="pass-loja2">Confirmar senha <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input id="pass-loja2" type="password" placeholder="••••••••"
                value={passLoja2} onChange={e => setPassLoja2(e.target.value)} autoComplete="new-password" required />
            </div>

            {lojaError && (
              <div className="login-error" role="alert">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>{lojaError}</span>
              </div>
            )}

            {lojaSuccess && (
              <div className="login-error" role="status" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
                <span>{lojaSuccess}</span>
              </div>
            )}

            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, margin: '4px 0' }}>
              Ao criar sua conta, você concorda com os{' '}
              <Link to="/termos" target="_blank" style={{ color: 'var(--primary)' }}>Termos de Uso</Link>
              {' '}e a{' '}
              <Link to="/privacidade" target="_blank" style={{ color: 'var(--primary)' }}>Política de Privacidade</Link>.
            </p>

            <button type="submit" className="btn btn-primary login-submit" disabled={lojaLoading}>
              {lojaLoading ? (
                <><span className="login-spinner" aria-hidden="true" />Criando loja...</>
              ) : 'Criar minha loja'}
            </button>

            <p className="login-links">
              Já tem conta? <Link to="/login">Entrar</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
