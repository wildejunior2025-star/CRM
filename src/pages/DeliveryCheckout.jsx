import { useState, useEffect, useRef } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { getEnderecoAtivo } from '../utils/enderecoPortal'
import { registrarPedido } from '../lib/meusPedidos'
import './DeliveryCheckout.css'

// Cliente lembrado no aparelho (Opção A — login sem senha)
const LS_CLIENTE = 'lojaonline_cliente'

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

function IconArrowLeft() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  )
}

function IconPix() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 7 10 10M17 7 7 17" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

function IconMoney() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01M18 12h.01" />
    </svg>
  )
}

function IconCard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function fmt(n) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtTelefone(val) {
  const digits = val.replace(/\D/g, '').slice(0, 11)
  if (digits.length <= 2) return digits
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
}

const INITIAL_FORM = {
  nome: '',
  telefone: '',
  email: '',
  cep: '',
  rua: '',
  numero: '',
  complemento: '',
  estado: '',
  cidade: '',
  bairro: '',
  pagamento: 'dinheiro',
  troco: '',
  observacoes: '',
}

export default function DeliveryCheckout() {
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state

  const [form, setForm]         = useState(INITIAL_FORM)
  const [errors, setErrors]     = useState({})
  const [enviando, setEnviando] = useState(false)
  const [erroGlobal, setErroGlobal] = useState(null)
  const [cidades, setCidades]       = useState([])
  const [loadingCidades, setLoadingCidades] = useState(false)
  const [buscandoCep, setBuscandoCep] = useState(false)
  const [erroCep, setErroCep]     = useState(null)
  const [userId, setUserId]         = useState(null)

  useEffect(() => {
    async function loadPerfil() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setUserId(user.id)
      const [{ data: cliente }, { data: profile }] = await Promise.all([
        supabase.from('clientes')
          .select('nome, telefone, cep, endereco, numero, complemento, bairro, cidade')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase.from('profiles')
          .select('nome, telefone')
          .eq('id', user.id)
          .maybeSingle(),
      ])
      const d = cliente ?? profile
      const endLocal = getEnderecoAtivo()
      if (d || endLocal) {
        setForm(prev => ({
          ...prev,
          nome:        d?.nome        || prev.nome,
          telefone:    d?.telefone    ? fmtTelefone(d.telefone) : prev.telefone,
          cep:         d?.cep         || endLocal?.cep         || prev.cep,
          rua:         d?.endereco    || endLocal?.endereco    || prev.rua,
          numero:      d?.numero      || endLocal?.numero      || prev.numero,
          complemento: d?.complemento || endLocal?.complemento || prev.complemento,
          bairro:      d?.bairro      || endLocal?.bairro      || prev.bairro,
          cidade:      d?.cidade      || endLocal?.cidade      || prev.cidade,
        }))
      }
    }
    loadPerfil()
  }, [])

  // Opção A — pré-preenche com o cliente lembrado neste aparelho
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_CLIENTE) || 'null')
      if (saved && typeof saved === 'object') {
        setForm(prev => ({
          ...prev,
          nome:        prev.nome        || saved.nome        || '',
          telefone:    prev.telefone    || (saved.telefone ? fmtTelefone(saved.telefone) : ''),
          email:       prev.email       || saved.email       || '',
          cep:         prev.cep         || saved.cep         || '',
          rua:         prev.rua         || saved.rua         || '',
          numero:      prev.numero      || saved.numero      || '',
          complemento: prev.complemento || saved.complemento || '',
          estado:      prev.estado      || saved.estado      || '',
          cidade:      prev.cidade      || saved.cidade      || '',
          bairro:      prev.bairro      || saved.bairro      || '',
        }))
        if (saved.estado) carregarCidades(saved.estado, saved.cidade)
      }
    } catch { /* ignora */ }
  }, [])

  // Reconhece o cliente pelo telefone (recuperar em outro aparelho, sem senha)
  const reconhecidoRef = useRef(false)
  useEffect(() => {
    const empId = state?.empresaId
    const tel = form.telefone.replace(/\D/g, '')
    if (!empId || tel.length < 10 || reconhecidoRef.current) return
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc('buscar_cliente_loja', { p_empresa_id: empId, p_telefone: tel })
      if (!data) return
      reconhecidoRef.current = true
      setForm(prev => ({
        ...prev,
        nome:        prev.nome.trim()        ? prev.nome        : (data.nome || ''),
        email:       prev.email.trim()       ? prev.email       : (data.email || ''),
        cep:         prev.cep.trim()         ? prev.cep         : (data.cep || ''),
        rua:         prev.rua.trim()         ? prev.rua         : (data.endereco || ''),
        numero:      prev.numero.trim()      ? prev.numero      : (data.numero || ''),
        complemento: prev.complemento.trim() ? prev.complemento : (data.complemento || ''),
        estado:      prev.estado             ? prev.estado      : (data.estado || ''),
        cidade:      prev.cidade             ? prev.cidade      : (data.cidade || ''),
        bairro:      prev.bairro.trim()      ? prev.bairro      : (data.bairro || ''),
      }))
      if (data.estado) carregarCidades(data.estado, data.cidade)
    }, 700)
    return () => clearTimeout(t)
  }, [form.telefone, state])

  if (!state?.itens?.length) {
    return <Navigate to="/lojas" replace />
  }

  const { empresaId, empresaNome, itens, subtotal, taxaEntrega } = state
  const total = subtotal + taxaEntrega

  function set(field, value) {
    setForm(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: null }))
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
        if (match) set('cidade', match)
      }
    } catch {
      setCidades([])
    } finally {
      setLoadingCidades(false)
    }
  }

  function handleCepChange(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 8)
    const fmt2 = v.length > 5 ? `${v.slice(0, 5)}-${v.slice(5)}` : v
    set('cep', fmt2)
    setErroCep(null)
    if (v.length === 8) buscarCep(v)
  }

  async function buscarCep(numeros) {
    setBuscandoCep(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${numeros}/json/`)
      const data = await res.json()
      if (data.erro) { setErroCep('CEP não encontrado.'); return }
      set('rua', data.logradouro || '')
      set('bairro', data.bairro || '')
      if (data.uf) {
        set('estado', data.uf)
        await carregarCidades(data.uf, data.localidade || '')
      }
    } catch {
      setErroCep('Erro ao buscar CEP.')
    } finally {
      setBuscandoCep(false)
    }
  }

  async function handleEstadoChange(uf) {
    set('estado', uf)
    set('cidade', '')
    setCidades([])
    if (uf) await carregarCidades(uf)
  }

  function validate() {
    const e = {}
    if (!form.nome.trim()) e.nome = 'Nome obrigatório'
    if (form.telefone.replace(/\D/g, '').length < 10) e.telefone = 'Telefone inválido'
    if (!form.rua.trim()) e.rua = 'Rua obrigatória'
    if (!form.numero.trim()) e.numero = 'Número obrigatório'
    if (!form.estado) e.estado = 'Estado obrigatório'
    if (!form.cidade) e.cidade = 'Cidade obrigatória'
    if (!form.bairro.trim()) e.bairro = 'Bairro obrigatório'
    if (form.pagamento === 'dinheiro' && form.troco) {
      const val = parseFloat(form.troco.replace(',', '.'))
      if (isNaN(val) || val < total) e.troco = `Valor deve ser maior que R$ ${fmt(total)}`
    }
    return e
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setErroGlobal(null)

    const errs = validate()
    if (Object.keys(errs).length > 0) {
      setErrors(errs)
      setTimeout(() => {
        document.querySelector('[data-field-error]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 50)
      return
    }

    setEnviando(true)

    // Cria/atualiza o cliente da loja (sem login, identificado pelo telefone)
    let clienteId = null
    try {
      const { data: cid } = await supabase.rpc('upsert_cliente_loja', {
        p_empresa_id:  empresaId,
        p_nome:        form.nome.trim(),
        p_telefone:    form.telefone,
        p_email:       form.email.trim(),
        p_cep:         form.cep,
        p_endereco:    form.rua.trim(),
        p_numero:      form.numero.trim(),
        p_complemento: form.complemento.trim(),
        p_bairro:      form.bairro.trim(),
        p_cidade:      form.cidade,
        p_estado:      form.estado,
      })
      clienteId = cid ?? null
    } catch { /* não bloqueia o pedido */ }

    const { data, error } = await supabase
      .from('pedidos_delivery')
      .insert({
        empresa_id:           empresaId,
        user_id:              userId ?? null,
        cliente_id:           clienteId,
        cliente_nome:         form.nome.trim(),
        cliente_telefone:     form.telefone,
        endereco_rua:         form.rua.trim(),
        endereco_numero:      form.numero.trim(),
        endereco_complemento: form.complemento.trim() || null,
        endereco_estado:      form.estado,
        endereco_cidade:      form.cidade,
        endereco_bairro:      form.bairro.trim(),
        tipo_entrega:         'entrega',
        origem: window.Capacitor?.isNativePlatform?.() ? 'app' : 'cardapio',
        itens: itens.map(i => ({
          produto_id:    i.id,
          nome:          i.nome,
          quantidade:    i.quantidade,
          preco_unitario: i.preco,
          subtotal:      i.quantidade * i.preco,
        })),
        subtotal,
        taxa_entrega:   taxaEntrega,
        total,
        forma_pagamento: form.pagamento,
        troco_para: form.pagamento === 'dinheiro' && form.troco
          ? Math.round(parseFloat(form.troco.replace(',', '.')) * 100) / 100
          : null,
        observacoes: form.observacoes.trim() || null,
      })
      .select('id')
      .single()

    setEnviando(false)

    if (error) { setErroGlobal(error.message); return }

    try {
      localStorage.removeItem(`sacola_${empresaId}`)
      localStorage.setItem(LS_CLIENTE, JSON.stringify({
        nome: form.nome.trim(), telefone: form.telefone, email: form.email.trim(),
        cep: form.cep, rua: form.rua.trim(), numero: form.numero.trim(),
        complemento: form.complemento.trim(), estado: form.estado, cidade: form.cidade, bairro: form.bairro.trim(),
      }))
    } catch { /* ok */ }
    registrarPedido(data.id, empresaId)
    navigate(`/pedido/${data.id}`, { replace: true })
  }

  return (
    <div className="dco-root">
      <header className="dco-header">
        <div className="dco-header-inner">
          <button className="dco-back-btn" onClick={() => navigate(-1)} aria-label="Voltar">
            <IconArrowLeft />
          </button>
          <span className="dco-logo">FWC</span>
          <span className="dco-header-divider" />
          <div>
            <span className="dco-header-title">Checkout</span>
            {empresaNome && <span className="dco-header-sub">{empresaNome}</span>}
          </div>
        </div>
      </header>

      <main className="dco-main">
        <form className="dco-form" onSubmit={handleSubmit} noValidate>
          <div className="dco-layout">
            <div className="dco-col-form">

              {/* Seus dados */}
              <section className="dco-section">
                <h2 className="dco-section-title">Seus dados</h2>
                <div className="dco-field-group">
                  <Field label="Nome completo" required error={errors.nome}>
                    <input
                      className={`dco-input${errors.nome ? ' dco-input--error' : ''}`}
                      placeholder="João da Silva"
                      value={form.nome}
                      onChange={e => set('nome', e.target.value)}
                      data-field-error={errors.nome ? true : undefined}
                    />
                  </Field>
                  <Field label="Telefone" required error={errors.telefone}>
                    <input
                      className={`dco-input${errors.telefone ? ' dco-input--error' : ''}`}
                      placeholder="(11) 99999-9999"
                      value={form.telefone}
                      onChange={e => set('telefone', fmtTelefone(e.target.value))}
                      inputMode="tel"
                      data-field-error={errors.telefone ? true : undefined}
                    />
                  </Field>
                  <Field label="E-mail" hint="Opcional">
                    <input
                      className="dco-input"
                      type="email"
                      placeholder="voce@email.com"
                      value={form.email}
                      onChange={e => set('email', e.target.value)}
                      inputMode="email"
                    />
                  </Field>
                </div>
              </section>

              {/* Endereço */}
              <section className="dco-section">
                <h2 className="dco-section-title">Endereço de entrega</h2>
                <div className="dco-field-group">

                  {/* CEP — opcional, preenche automático */}
                  <Field label="CEP" hint="Opcional — preenche o endereço automaticamente">
                    <div style={{ position: 'relative' }}>
                      <input
                        className="dco-input"
                        placeholder="00000-000"
                        value={form.cep}
                        onChange={handleCepChange}
                        inputMode="numeric"
                        maxLength={9}
                      />
                      {buscandoCep && (
                        <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--text-muted, #888)' }}>
                          Buscando...
                        </span>
                      )}
                    </div>
                    {erroCep && <span className="dco-field-error">{erroCep}</span>}
                  </Field>

                  {/* Rua */}
                  <Field label="Rua / Av." required error={errors.rua}>
                    <input
                      className={`dco-input${errors.rua ? ' dco-input--error' : ''}`}
                      placeholder="Rua das Flores"
                      value={form.rua}
                      onChange={e => set('rua', e.target.value)}
                      data-field-error={errors.rua ? true : undefined}
                    />
                  </Field>

                  {/* Número + Complemento */}
                  <div className="dco-row">
                    <Field label="Número" required error={errors.numero}>
                      <input
                        className={`dco-input${errors.numero ? ' dco-input--error' : ''}`}
                        placeholder="123"
                        value={form.numero}
                        onChange={e => set('numero', e.target.value)}
                        data-field-error={errors.numero ? true : undefined}
                      />
                    </Field>
                    <Field label="Complemento" hint="opcional">
                      <input
                        className="dco-input"
                        placeholder="Apto 4"
                        value={form.complemento}
                        onChange={e => set('complemento', e.target.value)}
                      />
                    </Field>
                  </div>

                  {/* Estado */}
                  <Field label="Estado" required error={errors.estado}>
                    <select
                      className={`dco-input dco-select${errors.estado ? ' dco-input--error' : ''}`}
                      value={form.estado}
                      onChange={e => handleEstadoChange(e.target.value)}
                      data-field-error={errors.estado ? true : undefined}
                    >
                      <option value="">Selecione o estado</option>
                      {ESTADOS_BR.map(({ uf, nome }) => (
                        <option key={uf} value={uf}>{nome} ({uf})</option>
                      ))}
                    </select>
                  </Field>

                  {/* Cidade */}
                  <Field label="Cidade" required error={errors.cidade}>
                    <select
                      className={`dco-input dco-select${errors.cidade ? ' dco-input--error' : ''}`}
                      value={form.cidade}
                      onChange={e => set('cidade', e.target.value)}
                      disabled={!form.estado || loadingCidades}
                      data-field-error={errors.cidade ? true : undefined}
                    >
                      <option value="">
                        {loadingCidades ? 'Carregando...' : form.estado ? 'Selecione a cidade' : 'Selecione o estado primeiro'}
                      </option>
                      {cidades.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </Field>

                  {/* Bairro */}
                  <Field label="Bairro" required error={errors.bairro}>
                    <input
                      className={`dco-input${errors.bairro ? ' dco-input--error' : ''}`}
                      placeholder="Centro"
                      value={form.bairro}
                      onChange={e => set('bairro', e.target.value)}
                      data-field-error={errors.bairro ? true : undefined}
                    />
                  </Field>

                </div>
              </section>

              {/* Pagamento */}
              <section className="dco-section">
                <h2 className="dco-section-title">Pagamento</h2>
                <div className="dco-payment-row">
                  {/* Pix oculto temporariamente — remover o style para reativar */}
                  <button type="button" style={{ display: 'none' }}
                    className={`dco-pay-btn${form.pagamento === 'pix' ? ' dco-pay-btn--active' : ''}`}
                    onClick={() => set('pagamento', 'pix')}>
                    <IconPix />
                    <span>Pix</span>
                    {form.pagamento === 'pix' && <span className="dco-pay-check"><IconCheck /></span>}
                  </button>
                  <button type="button"
                    className={`dco-pay-btn${form.pagamento === 'dinheiro' ? ' dco-pay-btn--active' : ''}`}
                    onClick={() => set('pagamento', 'dinheiro')}>
                    <IconMoney />
                    <span>Dinheiro</span>
                    {form.pagamento === 'dinheiro' && <span className="dco-pay-check"><IconCheck /></span>}
                  </button>
                  <button type="button"
                    className={`dco-pay-btn${form.pagamento === 'cartao' ? ' dco-pay-btn--active' : ''}`}
                    onClick={() => set('pagamento', 'cartao')}>
                    <IconCard />
                    <span>Cartão</span>
                    {form.pagamento === 'cartao' && <span className="dco-pay-check"><IconCheck /></span>}
                  </button>
                </div>
                {form.pagamento === 'dinheiro' && (
                  <Field label="Troco para R$" error={errors.troco}>
                    <input
                      className={`dco-input dco-input--troco${errors.troco ? ' dco-input--error' : ''}`}
                      placeholder={`Ex: ${fmt(Math.ceil(total / 10) * 10)}`}
                      value={form.troco}
                      onChange={e => set('troco', e.target.value)}
                      inputMode="decimal"
                    />
                  </Field>
                )}
              </section>

              {/* Observações */}
              <section className="dco-section">
                <h2 className="dco-section-title">Observações <span className="dco-optional">(opcional)</span></h2>
                <textarea
                  className="dco-textarea"
                  placeholder="Alguma observação sobre o pedido ou entrega..."
                  rows={3}
                  value={form.observacoes}
                  onChange={e => set('observacoes', e.target.value)}
                />
              </section>
            </div>

            <div className="dco-col-aside">
              <div className="dco-resumo">
                <h2 className="dco-section-title">Resumo do pedido</h2>
                <div className="dco-resumo-itens">
                  {itens.map(item => (
                    <div key={item.id} className="dco-resumo-item">
                      <span className="dco-resumo-item-qty">{item.quantidade}x</span>
                      <span className="dco-resumo-item-nome">{item.nome}</span>
                      <span className="dco-resumo-item-sub">R$ {fmt(item.quantidade * item.preco)}</span>
                    </div>
                  ))}
                </div>
                <div className="dco-resumo-totais">
                  <div className="dco-resumo-linha">
                    <span>Subtotal</span>
                    <span>R$ {fmt(subtotal)}</span>
                  </div>
                  <div className="dco-resumo-linha">
                    <span>Taxa de entrega</span>
                    <span>{taxaEntrega === 0 ? 'Grátis' : `R$ ${fmt(taxaEntrega)}`}</span>
                  </div>
                  <div className="dco-resumo-linha dco-resumo-total">
                    <span>Total</span>
                    <strong>R$ {fmt(total)}</strong>
                  </div>
                </div>

                {erroGlobal && <div className="dco-erro-global">{erroGlobal}</div>}

                <button type="submit" className="dco-btn-submit" disabled={enviando}>
                  {enviando ? <><span className="dco-spinner" />Enviando pedido...</> : 'Fazer pedido'}
                </button>
              </div>
            </div>
          </div>

          {erroGlobal && <div className="dco-erro-global dco-erro-mobile">{erroGlobal}</div>}

          <div className="dco-submit-mobile">
            <button type="submit" className="dco-btn-submit" disabled={enviando}>
              {enviando
                ? <><span className="dco-spinner" />Enviando pedido...</>
                : `Fazer pedido · R$ ${fmt(total)}`}
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}

function Field({ label, required, error, hint, children }) {
  return (
    <label className="dco-field">
      <span className="dco-label">
        {label}
        {required && <span className="dco-required">*</span>}
        {hint && <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-muted, #888)', marginLeft: 4 }}>({hint})</span>}
      </span>
      {children}
      {error && <span className="dco-field-error" data-field-error>{error}</span>}
    </label>
  )
}
