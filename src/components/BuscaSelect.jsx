import { useEffect, useMemo, useRef, useState } from 'react'

// Campo de escolher digitando, no lugar do <select> comprido.
//
// O <select> do navegador obriga a rolar a lista inteira atrás do item — com 80
// insumos cadastrados isso é uma eternidade no meio do serviço. Aqui a loja
// digita "fei" e sobra o feijão. Ignora acento e maiúscula ("feijao" acha
// "Feijão") e anda com as setas ↑ ↓ + Enter, pra quem monta ficha no teclado.
//
// opcoes: [{ key, label, sub?, tag? }]  — `sub` é a linha cinza de baixo
//                                          (ex.: "R$ 5,00 / kg"), `tag` é a
//                                          etiqueta da direita (ex.: "Receita").
// value:  a key escolhida (ou '' pra nada)
// onChange(key): devolve a key escolhida ('' quando limpa)

const norm = (s) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

export default function BuscaSelect({
  opcoes = [], value = '', onChange,
  placeholder = 'Digite pra buscar…',
  vazioLabel = '— nenhum —',
  permitirVazio = true,
  semResultado = 'Nada encontrado.',
  autoFocus = false,
  style,
}) {
  const lista = useMemo(
    () => opcoes.map(o => ({ ...o, norm: norm(`${o.label} ${o.sub ?? ''}`) })),
    [opcoes],
  )
  const selecionado = lista.find(o => o.key === value) || null

  const [aberto, setAberto] = useState(false)
  const [texto, setTexto] = useState('')
  const [ativo, setAtivo] = useState(0)   // item destacado pelas setas
  const wrapRef = useRef(null)
  const listaRef = useRef(null)

  // Fora de edição o campo mostra o que está escolhido.
  useEffect(() => { if (!aberto) setTexto(selecionado ? selecionado.label : '') }, [value, aberto]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setAberto(false)
        setTexto(selecionado ? selecionado.label : '')
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [selecionado])

  // Enquanto o texto for o do item escolhido, mostra tudo — quem abriu o campo
  // pra trocar não quer ver só o que já está lá.
  const q = norm(texto)
  const mostrandoEscolhido = selecionado && norm(selecionado.label) === q
  const filtradas = (q && !mostrandoEscolhido) ? lista.filter(o => o.norm.includes(q)) : lista

  useEffect(() => { setAtivo(0) }, [texto])

  function escolher(o) {
    onChange(o ? o.key : '')
    setTexto(o ? o.label : '')
    setAberto(false)
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!aberto) { setAberto(true); return }
      const passo = e.key === 'ArrowDown' ? 1 : -1
      setAtivo(i => {
        const n = Math.min(Math.max(i + passo, 0), Math.max(filtradas.length - 1, 0))
        listaRef.current?.children[n]?.scrollIntoView({ block: 'nearest' })
        return n
      })
    } else if (e.key === 'Enter') {
      if (aberto && filtradas[ativo]) { e.preventDefault(); escolher(filtradas[ativo]) }
    } else if (e.key === 'Escape') {
      if (aberto) { e.stopPropagation(); setAberto(false); setTexto(selecionado ? selecionado.label : '') }
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', minWidth: 0, ...style }}>
      <input
        type="text" value={texto} autoComplete="off" placeholder={placeholder} autoFocus={autoFocus}
        onChange={e => { setTexto(e.target.value); setAberto(true) }}
        onFocus={e => { e.target.select(); setAberto(true) }}
        onKeyDown={onKeyDown}
        style={{ width: '100%', boxSizing: 'border-box', padding: '9px 26px 9px 10px', borderRadius: 6,
          border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }} />
      <span style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)', fontSize: 11 }}>▼</span>

      {aberto && (
        <div ref={listaRef} style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 60,
          maxHeight: 260, overflowY: 'auto', background: 'var(--card-bg, var(--surface, var(--bg)))',
          border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 10px 28px rgba(0,0,0,.22)', padding: 4,
        }}>
          {permitirVazio && (
            <div onMouseDown={() => escolher(null)}
              style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)' }}>
              {vazioLabel}
            </div>
          )}
          {filtradas.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 13, color: 'var(--text-muted)' }}>{semResultado}</div>
          )}
          {filtradas.map((o, i) => (
            <div key={o.key} onMouseDown={() => escolher(o)} onMouseEnter={() => setAtivo(i)}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13.5,
                background: i === ativo ? 'var(--surface-hover, rgba(0,0,0,.06))'
                  : o.key === value ? 'var(--primary-bg, rgba(124,58,237,.12))' : 'transparent' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.label}
                {o.sub && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> · {o.sub}</span>}
              </span>
              {o.tag && (
                <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 20, padding: '1px 7px' }}>
                  {o.tag}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
