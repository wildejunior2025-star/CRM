import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'
import { UFS, buscarRuas, geocodeRua, geocodeCidade } from '../lib/enderecoBusca'
import MapaPinoEndereco from './MapaPinoEndereco'
import {
  LS_HIST,
  getEnderecoAtivo, getHistorico,
  salvarEnderecoAtivo, adicionarAoHistorico,
  removerDoHistorico, limparEnderecoAtivo, foiRemovido,
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

// Mesmo endereço? O CEP sozinho não serve: rua achada pelo mapa às vezes vem sem CEP.
const mesmoEndereco = (a, b) => !!a && !!b
  && (a.cep ?? '') === (b.cep ?? '') && (a.numero ?? '') === (b.numero ?? '') && (a.endereco ?? '') === (b.endereco ?? '')

// ── Modal ─────────────────────────────────────────────────────────────────────
export default function ModalEndereco({ onClose, onSalvo }) {
  const [historico, setHistorico] = useState(() => getHistorico())
  const [enderecoAtivo, setEnderecoAtivo] = useState(() => getEnderecoAtivo())
  const [mostrarForm, setMostrarForm] = useState(false)

  // Novo endereço em 3 passos: 1) a rua  2) o ponto no mapa  3) número e complemento
  const [passo, setPasso]         = useState(1)
  const [uf, setUf]               = useState('RN')
  const [cidadeBase, setCidadeBase] = useState('')   // cidade do perfil: 1ª tentativa da busca
  const [busca, setBusca]         = useState('')
  const [sugestoes, setSugestoes] = useState([])
  const [buscando, setBuscando]   = useState(false)
  const [naoAchou, setNaoAchou]   = useState(false)
  const [rua, setRua]             = useState(null)   // { logradouro, bairro, localidade, uf, cep }
  const [manual, setManual]       = useState(false)  // rua que não está na lista
  const [bairroManual, setBairroManual] = useState('')
  const [cidadeManual, setCidadeManual] = useState('')
  const [centro, setCentro]       = useState(null)   // onde o mapa abre
  const [coord, setCoord]         = useState(null)   // ponto confirmado pelo cliente
  const [procurandoPonto, setProcurandoPonto] = useState(false)
  const [numero, setNumero]       = useState('')
  const [complemento, setComplemento] = useState('')
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState(null)

  // Se não tem histórico, abre o formulário direto
  useEffect(() => {
    if (historico.length === 0) setMostrarForm(true)
  }, [historico.length])

  // Carrega endereço salvo no perfil (profiles) → histórico local, e a cidade/UF base da busca
  useEffect(() => {
    async function loadPerfil() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('profiles')
        .select('cep, endereco, numero, bairro, cidade, estado')
        .eq('id', user.id)
        .maybeSingle()
      if (data?.estado && UFS.includes(data.estado)) setUf(data.estado)
      if (data?.cidade) setCidadeBase(data.cidade)
      if (data && (data.cep || data.cidade)) {
        const endBanco = {
          cep:      data.cep      || '',
          endereco: data.endereco || '',
          numero:   data.numero   || '',
          bairro:   data.bairro   || '',
          cidade:   data.cidade   || '',
        }
        // Endereço que o cliente excluiu não volta sozinho
        if (foiRemovido(endBanco)) return
        setHistorico(prev => {
          const existe = prev.find(h => mesmoEndereco(h, endBanco))
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

  // ── Passo 1: sugere as ruas conforme o cliente digita ──
  useEffect(() => {
    if (passo !== 1 || rua || manual) return
    const termo = busca.trim()
    if (termo.length < 3) { setSugestoes([]); setNaoAchou(false); return }
    let vivo = true
    setBuscando(true)
    const t = setTimeout(async () => {
      try {
        const lista = await buscarRuas({ termo, uf, cidades: [cidadeBase] })
        if (!vivo) return
        setSugestoes(lista)
        setNaoAchou(lista.length === 0)
      } catch {
        if (vivo) { setSugestoes([]); setNaoAchou(true) }
      } finally {
        if (vivo) setBuscando(false)
      }
    }, 500)
    return () => { vivo = false; clearTimeout(t); setBuscando(false) }
  }, [busca, uf, cidadeBase, passo, rua, manual])

  function escolherRua(r) {
    setRua(r)
    setBusca(r.logradouro)
    if (r.uf && UFS.includes(r.uf)) setUf(r.uf)
    setSugestoes([])
    setNaoAchou(false)
    setError(null)
  }

  function trocarRua() {
    setRua(null)
    setManual(false)
    setCoord(null)
    setCentro(null)
    setError(null)
  }

  // Rua que o cadastro não tem (loteamento novo, nome popular): o cliente escreve e
  // marca no mapa. O que vale pra entrega é o pino.
  function usarRuaManual() {
    setManual(true)
    setSugestoes([])
    setNaoAchou(false)
  }

  // Dados da rua que valem daqui pra frente (da lista ou digitados à mão)
  const dadosRua = manual
    ? { logradouro: busca.trim(), bairro: bairroManual.trim(), localidade: cidadeManual.trim(), uf, cep: '' }
    : rua

  const podeIrParaMapa = manual
    ? busca.trim().length >= 3 && cidadeManual.trim().length >= 3
    : !!rua

  // ── Passo 2: abre o mapa já na rua escolhida ──
  async function irParaMapa() {
    if (!podeIrParaMapa || !dadosRua) return
    setError(null)
    setCoord(null)
    setCentro(null)
    setPasso(2)
    setProcurandoPonto(true)
    const g = await geocodeRua({
      rua: dadosRua.logradouro, bairro: dadosRua.bairro, cidade: dadosRua.localidade,
      estado: dadosRua.uf || uf, cep: dadosRua.cep,
    })
    if (g) {
      setCentro(g)
      setCoord(g)
    } else {
      // Não achou a rua no mapa: abre na cidade e o cliente toca no ponto da casa.
      const c = await geocodeCidade({ cidade: dadosRua.localidade, estado: dadosRua.uf || uf })
      if (c) setCentro(c)
    }
    setProcurandoPonto(false)
  }

  function aoMoverPino(c) {
    setCoord(c)
    setError(null)
  }

  function handleSelecionarHistorico(end) {
    salvarEnderecoAtivo(end)
    setEnderecoAtivo(end)
    onSalvo?.(end)
    onClose()
  }

  function handleExcluir(end) {
    if (!window.confirm(`Excluir este endereço?\n\n${linhaEndereco1(end)}\n${linhaEndereco2(end)}`)) return
    const restante = removerDoHistorico(end)
    setHistorico(restante)
    // Excluiu o que estava em uso: passa pro próximo da lista, ou fica sem endereço ativo
    if (mesmoEndereco(enderecoAtivo, end)) {
      if (restante[0]) {
        salvarEnderecoAtivo(restante[0])
        setEnderecoAtivo(restante[0])
        onSalvo?.(restante[0])
      } else {
        limparEnderecoAtivo()
        setEnderecoAtivo(null)
        onSalvo?.(null)
      }
    }
  }

  async function handleConfirmar(e) {
    e.preventDefault()
    if (!numero.trim()) { setError('Informe o número da casa (ou "s/n").'); return }
    if (!coord || !dadosRua) { setError('Marque o ponto no mapa.'); return }
    setSaving(true)
    setError(null)

    const novoEnd = {
      cep:         dadosRua.cep ? `${dadosRua.cep.slice(0, 5)}-${dadosRua.cep.slice(5)}` : '',
      endereco:    dadosRua.logradouro,
      numero:      numero.trim(),
      complemento: complemento.trim(),
      bairro:      dadosRua.bairro,
      cidade:      dadosRua.localidade,
      estado:      dadosRua.uf || uf,
      // Ponto confirmado no mapa: é ele que vale pro filtro das lojas e pra entrega.
      latitude:    coord.lat,
      longitude:   coord.lng,
    }

    const { error: err } = await supabase.rpc('salvar_endereco_portal', {
      p_cep:         novoEnd.cep,
      p_endereco:    novoEnd.endereco,
      p_numero:      novoEnd.numero,
      p_complemento: novoEnd.complemento,
      p_bairro:      novoEnd.bairro,
      p_cidade:      novoEnd.cidade,
    })
    if (err) { setSaving(false); setError(err.message); return }

    // Guarda o ponto e o estado no perfil (o RPC acima não leva). Se falhar, o endereço
    // já foi salvo e o ponto continua valendo neste aparelho.
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        await supabase.from('profiles')
          .update({ latitude: coord.lat, longitude: coord.lng, estado: novoEnd.estado })
          .eq('id', user.id)
      }
    } catch { /* ignora */ }
    setSaving(false)

    salvarEnderecoAtivo(novoEnd)
    adicionarAoHistorico(novoEnd)
    onSalvo?.(novoEnd)
    onClose()
  }

  function voltarDoFormulario() {
    // Do passo 1 volta pra lista de salvos; dos outros, um passo atrás.
    if (passo === 3) { setPasso(2); return }
    if (passo === 2) { setPasso(1); return }
    setMostrarForm(false)
  }

  const tituloPasso = passo === 1 ? 'Qual é a sua rua?' : passo === 2 ? 'Onde fica a sua casa?' : 'Falta pouco!'

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
          {mostrarForm ? tituloPasso : (historico.length > 0 ? 'Onde você quer receber?' : 'Onde você está?')}
        </h2>
        {historico.length === 0 && !mostrarForm && (
          <p className="ph-modal-subtitle">
            Precisamos do seu endereço para mostrar as lojas mais próximas de você.
          </p>
        )}

        {/* Lista de endereços salvos */}
        {historico.length > 0 && !mostrarForm && (
          <div className="ph-modal-hist">
            {historico.map((end, i) => {
              const ativo = mesmoEndereco(enderecoAtivo, end)
              return (
                <div key={`${end.cep}-${end.endereco}-${end.numero}-${i}`} className="ph-hist-row">
                  <button
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
                  <button
                    type="button"
                    className="ph-hist-excluir"
                    aria-label={`Excluir endereço ${linhaEndereco1(end)}`}
                    onClick={() => handleExcluir(end)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                      <path d="M10 11v6M14 11v6"/>
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                  </button>
                </div>
              )
            })}

            <button
              className="ph-hist-add-btn"
              onClick={() => { setMostrarForm(true); setPasso(1) }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Adicionar novo endereço
            </button>
          </div>
        )}

        {/* Novo endereço: 3 passos */}
        {mostrarForm && (
          <>
            {(historico.length > 0 || passo > 1) && (
              <button className="ph-modal-back" onClick={voltarDoFormulario}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
                {passo === 1 ? 'Voltar para endereços salvos' : 'Voltar'}
              </button>
            )}

            <div className="ph-end-passos" aria-label={`Passo ${passo} de 3`}>
              {[1, 2, 3].map(n => (
                <span key={n} className={`ph-end-passo${n === passo ? ' ativo' : ''}${n < passo ? ' feito' : ''}`} />
              ))}
              <span className="ph-end-passo-txt">Passo {passo} de 3</span>
            </div>

            {/* ── Passo 1: a rua ── */}
            {passo === 1 && (
              <div className="ph-modal-form">
                <div className="ph-modal-field">
                  <label className="ph-modal-label" htmlFor="modal-uf">Estado</label>
                  <select
                    id="modal-uf"
                    className="ph-modal-input"
                    value={uf}
                    onChange={e => { setUf(e.target.value); trocarRua() }}
                  >
                    {UFS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>

                <div className="ph-modal-field" style={{ position: 'relative' }}>
                  <label className="ph-modal-label" htmlFor="modal-rua">
                    Nome da rua <span className="ph-modal-required">*</span>
                  </label>
                  <input
                    id="modal-rua"
                    type="text"
                    className="ph-modal-input"
                    value={busca}
                    onChange={e => { setBusca(e.target.value); if (rua) trocarRua() }}
                    placeholder="Digite o nome da sua rua"
                    autoComplete="off"
                    autoFocus
                  />
                  {buscando && <span className="ph-modal-cep-hint">Buscando...</span>}
                </div>

                {sugestoes.length > 0 && !rua && (
                  <div className="ph-end-lista">
                    {sugestoes.map(r => (
                      <button key={`${r.cep}-${r.logradouro}-${r.bairro}-${r.localidade}`} type="button" onClick={() => escolherRua(r)}>
                        <strong>{r.logradouro}</strong>
                        <span>{[r.bairro, r.localidade].filter(Boolean).join(' · ')}</span>
                      </button>
                    ))}
                  </div>
                )}

                {rua && (
                  <div className="ph-end-escolhida">
                    <div>
                      <strong>{rua.logradouro}</strong>
                      <span>{[rua.bairro, rua.localidade].filter(Boolean).join(' · ')}</span>
                    </div>
                    <button type="button" onClick={trocarRua}>Trocar</button>
                  </div>
                )}

                {naoAchou && !buscando && !rua && !manual && busca.trim().length >= 3 && (
                  <div className="ph-end-aviso">
                    Não achei essa rua em <strong>{uf}</strong>. Confira o nome, ou
                    {' '}<button type="button" className="ph-end-link" onClick={usarRuaManual}>escreva à mão e marque no mapa</button>.
                  </div>
                )}

                {manual && (
                  <>
                    <div className="ph-modal-row">
                      <div className="ph-modal-field">
                        <label className="ph-modal-label" htmlFor="modal-bairro-m">Bairro</label>
                        <input id="modal-bairro-m" className="ph-modal-input" value={bairroManual}
                          onChange={e => setBairroManual(e.target.value)} placeholder="Centro" />
                      </div>
                      <div className="ph-modal-field">
                        <label className="ph-modal-label" htmlFor="modal-cidade-m">
                          Cidade <span className="ph-modal-required">*</span>
                        </label>
                        <input id="modal-cidade-m" className="ph-modal-input" value={cidadeManual}
                          onChange={e => setCidadeManual(e.target.value)} placeholder="Natal" />
                      </div>
                    </div>
                    <button type="button" className="ph-end-link" onClick={() => setManual(false)}>
                      Voltar a procurar na lista
                    </button>
                  </>
                )}

                <button
                  type="button"
                  className="ph-modal-btn"
                  disabled={!podeIrParaMapa}
                  onClick={irParaMapa}
                >
                  Próximo: marcar no mapa
                </button>
              </div>
            )}

            {/* ── Passo 2: o ponto no mapa ── */}
            {passo === 2 && dadosRua && (
              <div className="ph-modal-form">
                <p className="ph-end-dica">
                  <strong>{dadosRua.logradouro}</strong>
                  {[dadosRua.bairro, dadosRua.localidade].filter(Boolean).length > 0 && (
                    <> — {[dadosRua.bairro, dadosRua.localidade].filter(Boolean).join(', ')}</>
                  )}
                </p>
                {procurandoPonto
                  ? <p className="ph-end-dica">Procurando sua rua no mapa...</p>
                  : (
                    <p className="ph-end-dica">
                      {coord
                        ? '👉 Arraste o pino até a porta da sua casa, ou toque no ponto certo.'
                        : '👆 Não achei sua rua sozinho. Toque no mapa no ponto da sua casa.'}
                    </p>
                  )}
                <MapaPinoEndereco centro={centro} onMover={aoMoverPino} />
                {error && <div className="ph-modal-error">{error}</div>}
                <button
                  type="button"
                  className="ph-modal-btn"
                  disabled={!coord || procurandoPonto}
                  onClick={() => { setError(null); setPasso(3) }}
                >
                  Próximo: número da casa
                </button>
              </div>
            )}

            {/* ── Passo 3: número e complemento ── */}
            {passo === 3 && dadosRua && (
              <form onSubmit={handleConfirmar} className="ph-modal-form">
                <div className="ph-end-escolhida">
                  <div>
                    <strong>{dadosRua.logradouro}</strong>
                    <span>{[dadosRua.bairro, dadosRua.localidade].filter(Boolean).join(' · ')}</span>
                  </div>
                  <span aria-hidden="true">📍</span>
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
                      value={numero}
                      onChange={e => { setNumero(e.target.value); setError(null) }}
                      placeholder="123"
                      inputMode="numeric"
                      autoFocus
                    />
                  </div>
                  <div className="ph-modal-field">
                    <label className="ph-modal-label" htmlFor="modal-complemento">Complemento</label>
                    <input
                      id="modal-complemento"
                      type="text"
                      className="ph-modal-input"
                      value={complemento}
                      onChange={e => setComplemento(e.target.value)}
                      placeholder="Apto 4, casa azul..."
                    />
                  </div>
                </div>

                {error && <div className="ph-modal-error">{error}</div>}

                <button
                  type="submit"
                  className="ph-modal-btn"
                  disabled={!numero.trim() || saving}
                >
                  {saving
                    ? <><span className="ph-modal-spinner" /> Salvando...</>
                    : 'Confirmar endereço'
                  }
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  )
}
