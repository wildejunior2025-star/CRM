import { useEffect, useState } from 'react'
import { buscarRuas, geocodeRua, geocodeCidade } from '../lib/enderecoBusca'
import MapaPinoEndereco from './MapaPinoEndereco'
import '../pages/PortalHome.css' // .ph-end-* (lista de ruas, mapa, passos)

// Endereço do cadastro do cliente em 3 passos — o MESMO fluxo do endereço dentro do app:
//   1) o nome da rua (sugere conforme digita e o cliente confirma)
//   2) o ponto da casa no mapa (arrasta o pino)
//   3) o número e o complemento
// Entrega pro cadastro: { cep, endereco, numero, complemento, bairro, cidade, estado, latitude, longitude }.
// Só atendemos a região de Natal: a pessoa não indica gente de outra cidade.
const UF = 'RN'
const CIDADES = ['Natal', 'São Gonçalo do Amarante']
const BBOX = [-35.45, -6.00, -35.10, -5.65] // Natal + São Gonçalo do Amarante + arredores
const norm = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const cidadePermitida = c => CIDADES.some(x => norm(x) === norm(c))

export default function EnderecoEmPassos({ onVoltar, onConcluir }) {
  const [passo, setPasso]         = useState(1)
  const uf = UF
  const [busca, setBusca]         = useState('')
  const [sugestoes, setSugestoes] = useState([])
  const [buscando, setBuscando]   = useState(false)
  const [naoAchou, setNaoAchou]   = useState(false)
  const [rua, setRua]             = useState(null)   // { logradouro, bairro, localidade, uf, cep }
  const [manual, setManual]       = useState(false)  // rua que não está na lista
  const [bairroManual, setBairroManual] = useState('')
  const [cidadeManual, setCidadeManual] = useState(CIDADES[0])
  const [centro, setCentro]       = useState(null)
  const [coord, setCoord]         = useState(null)
  const [procurandoPonto, setProcurandoPonto] = useState(false)
  const [numero, setNumero]       = useState('')
  const [complemento, setComplemento] = useState('')
  const [erro, setErro]           = useState(null)

  // Passo 1: sugere as ruas conforme digita
  useEffect(() => {
    if (passo !== 1 || rua || manual) return
    const termo = busca.trim()
    if (termo.length < 3) { setSugestoes([]); setNaoAchou(false); return }
    let vivo = true
    setBuscando(true)
    const t = setTimeout(async () => {
      try {
        const lista = (await buscarRuas({ termo, uf, cidades: CIDADES, bbox: BBOX })).filter(r => cidadePermitida(r.localidade))
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
  }, [busca, passo, rua, manual])

  function escolherRua(r) {
    setRua(r)
    setBusca(r.logradouro)
    setSugestoes([])
    setNaoAchou(false)
    setErro(null)
  }

  function trocarRua() {
    setRua(null); setManual(false); setCoord(null); setCentro(null); setErro(null)
  }

  function usarRuaManual() {
    setManual(true); setSugestoes([]); setNaoAchou(false)
  }

  // Dados da rua que valem daqui pra frente (da lista ou digitados à mão)
  const dadosRua = manual
    ? { logradouro: busca.trim(), bairro: bairroManual.trim(), localidade: cidadeManual.trim(), uf, cep: '' }
    : rua

  const podeIrParaMapa = manual
    ? busca.trim().length >= 3 && cidadeManual.trim().length >= 3 && bairroManual.trim().length >= 2
    : !!rua

  async function irParaMapa() {
    if (!podeIrParaMapa || !dadosRua) return
    setErro(null); setCoord(null); setCentro(null)
    setPasso(2)
    setProcurandoPonto(true)
    const g = await geocodeRua({
      rua: dadosRua.logradouro, bairro: dadosRua.bairro, cidade: dadosRua.localidade,
      estado: dadosRua.uf || uf, cep: dadosRua.cep,
    })
    if (g) {
      setCentro(g); setCoord(g)
    } else {
      // Não achou a rua no mapa: abre na cidade e o cliente toca no ponto da casa.
      const c = await geocodeCidade({ cidade: dadosRua.localidade, estado: dadosRua.uf || uf })
      if (c) setCentro(c)
    }
    setProcurandoPonto(false)
  }

  function concluir() {
    if (!numero.trim()) { setErro('Informe o número da casa (ou "s/n").'); return }
    if (!coord || !dadosRua) { setErro('Marque o ponto da casa no mapa.'); return }
    // O ViaCEP já traz o hífen ("59296-391"): formata a partir dos números.
    const cepNum = String(dadosRua.cep ?? '').replace(/\D/g, '')
    onConcluir({
      cep: cepNum.length === 8 ? `${cepNum.slice(0, 5)}-${cepNum.slice(5)}` : cepNum,
      endereco: dadosRua.logradouro,
      numero: numero.trim(),
      complemento: complemento.trim(),
      bairro: dadosRua.bairro,
      cidade: dadosRua.localidade,
      estado: dadosRua.uf || uf,
      latitude: coord.lat,
      longitude: coord.lng,
    })
  }

  // Enter dentro do passo não pode enviar o cadastro inteiro: só avança o passo em que está.
  function enterAvanca(e) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (passo === 1 && podeIrParaMapa) irParaMapa()
    else if (passo === 3) concluir()
  }

  const titulo = passo === 1 ? 'Qual é a sua rua?' : passo === 2 ? 'Onde fica a sua casa?' : 'Falta pouco!'
  const botaoVoltar = {
    flex: '0 0 auto', padding: '0 18px',
    border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)',
  }

  return (
    <div onKeyDown={enterAvanca} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: '8px 0 0', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{titulo}</p>

      <div className="ph-end-passos" aria-label={`Passo ${passo} de 3`} style={{ marginBottom: 0 }}>
        {[1, 2, 3].map(n => (
          <span key={n} className={`ph-end-passo${n === passo ? ' ativo' : ''}${n < passo ? ' feito' : ''}`} />
        ))}
        <span className="ph-end-passo-txt">Endereço · passo {passo} de 3</span>
      </div>

      {/* ── 1: a rua ── */}
      {passo === 1 && (<>
        <div className="form-field" style={{ position: 'relative' }}>
          <label htmlFor="end-rua">Nome da rua <span style={{ color: 'var(--danger)' }}>*</span></label>
          <input id="end-rua" type="text" placeholder="Digite o nome da sua rua" value={busca}
            onChange={e => { setBusca(e.target.value); if (rua) trocarRua() }} autoComplete="off" />
          {buscando && (
            <span style={{ position: 'absolute', right: 10, top: 34, fontSize: 12, color: 'var(--text-muted)' }}>Buscando...</span>
          )}
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
            Não achei essa rua em Natal nem em São Gonçalo do Amarante. Confira o nome, ou
            {' '}<button type="button" className="ph-end-link" onClick={usarRuaManual}>escreva à mão e marque no mapa</button>.
          </div>
        )}

        {manual && (<>
          <div className="addr-row addr-row--estado-cidade">
            <div className="form-field">
              <label htmlFor="end-bairro-m">Bairro <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input id="end-bairro-m" type="text" value={bairroManual} onChange={e => setBairroManual(e.target.value)} placeholder="Centro" />
            </div>
            <div className="form-field">
              <label htmlFor="end-cidade-m">Cidade <span style={{ color: 'var(--danger)' }}>*</span></label>
              <select id="end-cidade-m" value={cidadeManual} onChange={e => setCidadeManual(e.target.value)}>
                {CIDADES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <button type="button" className="ph-end-link" onClick={() => setManual(false)}>Voltar a procurar na lista</button>
        </>)}

        {erro && <div className="login-error" role="alert"><span>{erro}</span></div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button type="button" className="btn" onClick={onVoltar} style={botaoVoltar}>← Voltar</button>
          <button type="button" className="btn btn-primary login-submit" disabled={!podeIrParaMapa}
            onClick={irParaMapa} style={{ flex: 1, marginTop: 0 }}>
            Próximo: marcar no mapa
          </button>
        </div>
      </>)}

      {/* ── 2: o ponto no mapa ── */}
      {passo === 2 && dadosRua && (<>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>
          <strong>{dadosRua.logradouro}</strong>
          {[dadosRua.bairro, dadosRua.localidade].filter(Boolean).length > 0 && (
            <> — {[dadosRua.bairro, dadosRua.localidade].filter(Boolean).join(', ')}</>
          )}
        </p>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text)' }}>
          {procurandoPonto
            ? 'Procurando sua rua no mapa...'
            : coord
              ? '👉 Arraste o pino até a porta da sua casa, ou toque no ponto certo.'
              : '👆 Não achei sua rua sozinho. Toque no mapa no ponto da sua casa.'}
        </p>
        <MapaPinoEndereco centro={centro} onMover={c => { setCoord(c); setErro(null) }} />
        {erro && <div className="login-error" role="alert"><span>{erro}</span></div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button type="button" className="btn" onClick={() => setPasso(1)} style={botaoVoltar}>← Voltar</button>
          <button type="button" className="btn btn-primary login-submit" disabled={!coord || procurandoPonto}
            onClick={() => { setErro(null); setPasso(3) }} style={{ flex: 1, marginTop: 0 }}>
            Próximo: número da casa
          </button>
        </div>
      </>)}

      {/* ── 3: número e complemento ── */}
      {passo === 3 && dadosRua && (<>
        <div className="ph-end-escolhida">
          <div>
            <strong>{dadosRua.logradouro}</strong>
            <span>{[dadosRua.bairro, dadosRua.localidade].filter(Boolean).join(' · ')}</span>
          </div>
          <span aria-hidden="true">📍</span>
        </div>
        <div className="addr-row addr-row--num-comp">
          <div className="form-field">
            <label htmlFor="end-numero">Número <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input id="end-numero" type="text" placeholder="123" value={numero} autoFocus
              onChange={e => { setNumero(e.target.value); setErro(null) }} />
          </div>
          <div className="form-field">
            <label htmlFor="end-compl">Complemento <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>(opc.)</span></label>
            <input id="end-compl" type="text" placeholder="Apto 4, casa azul..." value={complemento}
              onChange={e => setComplemento(e.target.value)} />
          </div>
        </div>
        {erro && <div className="login-error" role="alert"><span>{erro}</span></div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button type="button" className="btn" onClick={() => setPasso(2)} style={botaoVoltar}>← Voltar</button>
          <button type="button" className="btn btn-primary login-submit" disabled={!numero.trim()}
            onClick={concluir} style={{ flex: 1, marginTop: 0 }}>
            Confirmar endereço
          </button>
        </div>
      </>)}
    </div>
  )
}
