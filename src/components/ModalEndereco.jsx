import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'
import {
  LS_HIST,
  getEnderecoAtivo, getHistorico,
  salvarEnderecoAtivo, adicionarAoHistorico,
} from '../utils/enderecoPortal'
import '../pages/PortalHome.css'

// ── Ícones inline ─────────────────────────────────────────────────────────────
function IconMapPin({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 10c0 6-8 13-8 13s-8-7-8-13a8 8 0 0 1 16 0Z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  )
}

function IconClock({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  )
}

// ── Helpers de display ────────────────────────────────────────────────────────
function linhaEndereco1(end) {
  if (!end) return 'Adicionar endereço'
  const partes = [end.endereco, end.numero].filter(Boolean)
  return partes.join(', ') || end.cep || 'Endereço'
}

function linhaEndereco2(end) {
  if (!end) return ''
  const partes = [end.bairro, end.cidade].filter(Boolean)
  return partes.join(', ')
}

// ── Modal ─────────────────────────────────────────────────────────────────────
export default function ModalEndereco({ onClose, onSalvo }) {
  const [historico, setHistorico] = useState(() => getHistorico())
  const [enderecoAtivo, setEnderecoAtivo] = useState(() => getEnderecoAtivo())
  const [mostrarForm, setMostrarForm] = useState(false)

  const [form, setForm] = useState({
    cep: '', endereco: '', numero: '', complemento: '', bairro: '', cidade: '',
  })
  const [buscandoCep, setBuscandoCep]     = useState(false)
  const [erroCep, setErroCep]             = useState(null)
  const [saving, setSaving]               = useState(false)
  const [error, setError]                 = useState(null)

  // Se não tem histórico, abre o formulário direto
  useEffect(() => {
    if (historico.length === 0) setMostrarForm(true)
  }, [historico.length])

  // Carrega endereço salvo no perfil (profiles) → histórico local
  useEffect(() => {
    async function loadPerfil() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('profiles')
        .select('cep, endereco, numero, bairro, cidade')
        .eq('id', user.id)
        .maybeSingle()
      if (data && (data.cep || data.cidade)) {
        const endBanco = {
          cep:      data.cep      || '',
          endereco: data.endereco || '',
          numero:   data.numero   || '',
          bairro:   data.bairro   || '',
          cidade:   data.cidade   || '',
        }
        setHistorico(prev => {
          const existe = prev.find(h => h.cep === endBanco.cep && h.numero === endBanco.numero)
          if (!existe) {
            const novoHist = [endBanco, ...prev].slice(0, 5)
            localStorage.setItem(LS_HIST, JSON.stringify(novoHist))
            return novoHist
          }
          return prev
        })
      }
    }
    loadPerfil()
  }, [])

  function setField(field) {
    return e => {
      setForm(p => ({ ...p, [field]: e.target.value }))
      setError(null)
    }
  }

  function handleCepChange(e) {
    const v = e.target.value.replace(/\D/g, '').slice(0, 8)
    const fmt = v.length > 5 ? `${v.slice(0, 5)}-${v.slice(5)}` : v
    setForm(p => ({ ...p, cep: fmt }))
    setErroCep(null)
    if (v.length === 8) buscarCep(v)
  }

  async function buscarCep(numeros) {
    setBuscandoCep(true)
    try {
      const res = await fetch(`https://viacep.com.br/ws/${numeros}/json/`)
      const data = await res.json()
      if (data.erro) { setErroCep('CEP não encontrado.'); return }
      setForm(p => ({
        ...p,
        endereco: data.logradouro || p.endereco,
        bairro:   data.bairro    || p.bairro,
        cidade:   data.localidade || p.cidade,
      }))
    } catch {
      setErroCep('Erro ao buscar CEP. Tente novamente.')
    } finally {
      setBuscandoCep(false)
    }
  }

  function handleSelecionarHistorico(end) {
    salvarEnderecoAtivo(end)
    setEnderecoAtivo(end)
    onSalvo?.(end)
    onClose()
  }

  async function handleConfirmar(e) {
    e.preventDefault()
    if (!form.cep.trim() || !form.numero.trim()) {
      setError('CEP e número são obrigatórios.')
      return
    }
    setSaving(true)
    setError(null)

    const novoEnd = {
      cep:      form.cep.trim(),
      endereco: form.endereco.trim(),
      numero:   form.numero.trim(),
      bairro:   form.bairro.trim(),
      cidade:   form.cidade.trim(),
    }

    const { error: err } = await supabase.rpc('salvar_endereco_portal', {
      p_cep:         novoEnd.cep,
      p_endereco:    novoEnd.endereco,
      p_numero:      novoEnd.numero,
      p_complemento: form.complemento.trim(),
      p_bairro:      novoEnd.bairro,
      p_cidade:      novoEnd.cidade,
    })
    setSaving(false)
    if (err) { setError(err.message); return }

    salvarEnderecoAtivo(novoEnd)
    adicionarAoHistorico(novoEnd)
    onSalvo?.(novoEnd)
    onClose()
  }

  const podeConfirmar = form.cep.trim().length >= 8 && form.numero.trim().length > 0 && !saving

  return (
    <div
      className="ph-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ph-modal-title"
      onClick={e => { if (e.target === e.currentTarget && historico.length > 0) onClose() }}
    >
      <div className="ph-modal">
        <div className="ph-modal-icon">
          <IconMapPin size={28} />
        </div>

        <h2 id="ph-modal-title" className="ph-modal-title">
          {historico.length > 0 ? 'Onde você quer receber?' : 'Onde você está?'}
        </h2>
        {historico.length === 0 && (
          <p className="ph-modal-subtitle">
            Precisamos do seu endereço para mostrar as lojas mais próximas de você.
          </p>
        )}

        {/* Lista de endereços salvos */}
        {historico.length > 0 && !mostrarForm && (
          <div className="ph-modal-hist">
            {historico.map((end, i) => {
              const ativo = enderecoAtivo?.cep === end.cep && enderecoAtivo?.numero === end.numero
              return (
                <button
                  key={`${end.cep}-${end.numero}-${i}`}
                  className={`ph-hist-item${ativo ? ' ph-hist-item--ativo' : ''}`}
                  onClick={() => handleSelecionarHistorico(end)}
                >
                  <span className="ph-hist-clock">
                    <IconClock size={18} />
                  </span>
                  <span className="ph-hist-texto">
                    <span className="ph-hist-linha1">{linhaEndereco1(end)}</span>
                    {linhaEndereco2(end) && (
                      <span className="ph-hist-linha2">{linhaEndereco2(end)}</span>
                    )}
                  </span>
                  {ativo && (
                    <span className="ph-hist-check">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </span>
                  )}
                </button>
              )
            })}

            <button
              className="ph-hist-add-btn"
              onClick={() => setMostrarForm(true)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Adicionar novo endereço
            </button>
          </div>
        )}

        {/* Formulário de novo endereço */}
        {mostrarForm && (
          <>
            {historico.length > 0 && (
              <button className="ph-modal-back" onClick={() => setMostrarForm(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                Voltar para endereços salvos
              </button>
            )}

            <form onSubmit={handleConfirmar} className="ph-modal-form">
              <div className="ph-modal-field" style={{ position: 'relative' }}>
                <label className="ph-modal-label" htmlFor="modal-cep">
                  CEP <span className="ph-modal-required">*</span>
                </label>
                <input
                  id="modal-cep"
                  type="text"
                  className="ph-modal-input"
                  value={form.cep}
                  onChange={handleCepChange}
                  placeholder="00000-000"
                  maxLength={9}
                  autoComplete="postal-code"
                  inputMode="numeric"
                  autoFocus
                />
                {buscandoCep && <span className="ph-modal-cep-hint">Buscando...</span>}
                {erroCep && <span className="ph-modal-field-error">{erroCep}</span>}
              </div>

              <div className="ph-modal-field">
                <label className="ph-modal-label" htmlFor="modal-endereco">Rua / Av.</label>
                <input
                  id="modal-endereco"
                  type="text"
                  className="ph-modal-input"
                  value={form.endereco}
                  onChange={setField('endereco')}
                  placeholder="Rua das Flores"
                  autoComplete="street-address"
                />
              </div>

              <div className="ph-modal-row">
                <div className="ph-modal-field">
                  <label className="ph-modal-label" htmlFor="modal-numero">
                    Número <span className="ph-modal-required">*</span>
                  </label>
                  <input
                    id="modal-numero"
                    type="text"
                    className="ph-modal-input"
                    value={form.numero}
                    onChange={setField('numero')}
                    placeholder="123"
                    inputMode="numeric"
                  />
                </div>
                <div className="ph-modal-field">
                  <label className="ph-modal-label" htmlFor="modal-complemento">Complemento</label>
                  <input
                    id="modal-complemento"
                    type="text"
                    className="ph-modal-input"
                    value={form.complemento}
                    onChange={setField('complemento')}
                    placeholder="Apto 4"
                  />
                </div>
              </div>

              <div className="ph-modal-row">
                <div className="ph-modal-field">
                  <label className="ph-modal-label" htmlFor="modal-bairro">Bairro</label>
                  <input
                    id="modal-bairro"
                    type="text"
                    className="ph-modal-input"
                    value={form.bairro}
                    onChange={setField('bairro')}
                    placeholder="Centro"
                  />
                </div>
                <div className="ph-modal-field">
                  <label className="ph-modal-label" htmlFor="modal-cidade">Cidade</label>
                  <input
                    id="modal-cidade"
                    type="text"
                    className="ph-modal-input"
                    value={form.cidade}
                    onChange={setField('cidade')}
                    placeholder="Mossoró"
                  />
                </div>
              </div>

              {error && <div className="ph-modal-error">{error}</div>}

              <button
                type="submit"
                className="ph-modal-btn"
                disabled={!podeConfirmar}
              >
                {saving
                  ? <><span className="ph-modal-spinner" /> Salvando...</>
                  : 'Confirmar endereço'
                }
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
