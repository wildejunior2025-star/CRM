import { useEffect, useMemo, useRef, useState } from 'react'

// Escolha de produto com busca: botão (verde = baixa estoque, vermelho = não
// baixa) que abre uma lista onde dá pra digitar o nome. A lista é "fixed" pra
// não ser cortada pelo cartão do item.
const norm = (s) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
const RED = '#ea1d2c'
const VERDE = '#16a34a'

export default function IfoodProdutoCombo({ valor, automatico, produtos, onChange }) {
  const [aberto, setAberto] = useState(false)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState(null)
  const botaoRef = useRef(null)
  const painelRef = useRef(null)
  const inputRef = useRef(null)

  const escolhido = valor ? produtos.find(p => p.id === valor) : null
  const ligado = escolhido || automatico
  const texto = escolhido ? escolhido.nome : automatico ? automatico.nome : 'Escolher produto'
  // Produto ligado mas SEM controle de estoque (ex.: prato feito na hora): o
  // pedido não baixa nada, então não pode aparecer verde como se baixasse.
  const semControle = !!ligado && ligado.controla_estoque === false
  const cor = semControle ? '#6b7280' : ligado ? VERDE : RED

  function abrir() {
    const r = botaoRef.current?.getBoundingClientRect()
    if (r) {
      const largura = Math.min(340, window.innerWidth - 24)
      const esq = Math.max(12, Math.min(r.left, window.innerWidth - largura - 12))
      const abaixo = window.innerHeight - r.bottom
      const cabeEmbaixo = abaixo >= 300 || abaixo >= r.top
      setPos({
        left: esq, width: largura,
        ...(cabeEmbaixo
          ? { top: r.bottom + 6, maxHeight: Math.max(220, Math.min(340, abaixo - 16)) }
          : { bottom: window.innerHeight - r.top + 6, maxHeight: Math.max(220, Math.min(340, r.top - 16)) }),
      })
    }
    setQ('')
    setAberto(true)
  }

  useEffect(() => {
    if (!aberto) return
    inputRef.current?.focus()
    const fora = (e) => {
      if (painelRef.current?.contains(e.target) || botaoRef.current?.contains(e.target)) return
      setAberto(false)
    }
    const esc = (e) => { if (e.key === 'Escape') setAberto(false) }
    const fecha = () => setAberto(false)
    document.addEventListener('mousedown', fora)
    document.addEventListener('touchstart', fora)
    document.addEventListener('keydown', esc)
    window.addEventListener('scroll', fecha, true)
    window.addEventListener('resize', fecha)
    return () => {
      document.removeEventListener('mousedown', fora)
      document.removeEventListener('touchstart', fora)
      document.removeEventListener('keydown', esc)
      window.removeEventListener('scroll', fecha, true)
      window.removeEventListener('resize', fecha)
    }
  }, [aberto])

  const lista = useMemo(() => {
    const t = norm(q)
    if (!t) return produtos
    // todas as palavras digitadas precisam aparecer ("fanta uva" acha "Fanta uva lata")
    const palavras = t.split(/\s+/)
    return produtos.filter(p => { const n = norm(p.nome); return palavras.every(w => n.includes(w)) })
  }, [q, produtos])

  function escolher(id) { setAberto(false); onChange(id) }

  return (
    <>
      <button
        ref={botaoRef}
        type="button"
        onClick={() => (aberto ? setAberto(false) : abrir())}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
          padding: '5px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
          border: `1px solid ${cor}`, color: cor,
          background: semControle ? 'rgba(107,114,128,.10)' : ligado ? 'rgba(22,163,74,.08)' : 'rgba(234,29,44,.08)',
        }}
        title="Clique para escolher qual produto baixa do estoque"
      >
        <span>{semControle ? '–' : ligado ? '✓' : '⚠'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{texto}</span>
        {semControle
          ? <span style={{ fontWeight: 400, opacity: .85 }}>· sem controle de estoque</span>
          : !escolhido && automatico && <span style={{ fontWeight: 400, opacity: .75 }}>· automático</span>}
        <span style={{ opacity: .6 }}>▾</span>
      </button>

      {aberto && pos && (
        <div
          ref={painelRef}
          style={{
            position: 'fixed', zIndex: 2000, left: pos.left, width: pos.width,
            top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight,
            display: 'flex', flexDirection: 'column',
            background: 'var(--surface, var(--bg, #fff))', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 12,
            boxShadow: '0 12px 32px rgba(0,0,0,.22)', overflow: 'hidden',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input
              ref={inputRef}
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="🔍 Digite o nome do produto…"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 8, fontSize: 14,
                border: '1px solid var(--border)', background: 'var(--input-bg, transparent)', color: 'var(--text)', outline: 'none',
              }}
            />
          </div>
          <div style={{ overflowY: 'auto', padding: 4 }}>
            {(escolhido || automatico) && !q && (
              <button type="button" onClick={() => escolher(null)} style={linha(false, true)}>
                {escolhido ? '↩ Tirar a ligação (voltar ao automático / não baixar)' : 'Nenhum (não baixar)'}
              </button>
            )}
            {lista.length === 0 && (
              <div style={{ padding: '14px 10px', fontSize: 13, color: 'var(--text-muted)' }}>Nenhum produto com esse nome.</div>
            )}
            {lista.map(p => (
              <button key={p.id} type="button" onClick={() => escolher(p.id)} style={linha(p.id === valor)}>
                <span style={{ flex: 1, textAlign: 'left' }}>{p.nome}</span>
                {p.controla_estoque === false && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>sem controle de estoque</span>}
                {p.id === valor && <span style={{ color: VERDE }}>✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function linha(ativa, discreta) {
  return {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '9px 10px', borderRadius: 8,
    border: 'none', cursor: 'pointer', fontSize: discreta ? 12.5 : 14,
    background: ativa ? 'rgba(22,163,74,.10)' : 'transparent',
    color: discreta ? 'var(--text-muted)' : 'var(--text)', textAlign: 'left',
  }
}
