import { useEffect, useRef, useState } from 'react'
import { adicionalComplementos, blocosDeOpcoes } from '../lib/complementos'

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

// Botão de +/− do cardápio público (mesa e link do cliente).
export const btnQtd = {
  width: 34, height: 34, borderRadius: 9, cursor: 'pointer', flexShrink: 0,
  border: '1px solid #7c3aed', background: 'transparent', color: '#fff', fontSize: 18, fontWeight: 700,
}

// Modal "monte sua quentinha" — escolhe complementos por grupo (min/max).
// Usado no QR da mesa e no link do cliente: os dois montam o prato igual.
export default function ModalComplementos({ produto, grupos, semObrigatorios, onClose, onConfirm }) {
  const [sel, setSel] = useState({}) // { grupoId: [opcaoId] }
  const base = Number(produto.preco_venda)

  // Refs pra pular sozinho de um grupo pro outro (ver `avancar`).
  const corpoRef = useRef(null)
  const gruposRef = useRef({})
  const [destaque, setDestaque] = useState(null)

  // Fechou o grupo (escolheu tudo que podia)? Rola até o próximo que ainda
  // aceita escolha. Veio da pizzaria: o cliente marcava o sabor e parava ali,
  // sem nunca ver a BORDA logo abaixo.
  function avancar(grupoFeito, selAtual) {
    const i = grupos.findIndex(g => g.id === grupoFeito.id)
    const proximo = grupos.slice(i + 1).find(g => (selAtual[g.id]?.length ?? 0) < (g.max ?? 1))
    if (!proximo) return
    setDestaque(proximo.id)
    requestAnimationFrame(() => {
      const corpo = corpoRef.current
      const alvo = gruposRef.current[proximo.id]
      if (!corpo || !alvo) return
      const topo = corpo.scrollTop + (alvo.getBoundingClientRect().top - corpo.getBoundingClientRect().top) - 10
      corpo.scrollTo({ top: topo, behavior: 'smooth' })
    })
  }

  useEffect(() => {
    if (!destaque) return
    const t = setTimeout(() => setDestaque(null), 1600)
    return () => clearTimeout(t)
  }, [destaque])

  function toggle(g, o) {
    const atual = sel[g.id] ?? []
    const tem = atual.includes(o.id)
    let novo
    if (g.max === 1) novo = tem ? [] : [o.id]
    else if (tem) novo = atual.filter(x => x !== o.id)
    else if (atual.length >= g.max) novo = atual // trava no máximo
    else novo = [...atual, o.id]
    const proximaSel = { ...sel, [g.id]: novo }
    setSel(proximaSel)
    if (!tem && novo.length >= (g.max ?? 1)) avancar(g, proximaSel)
  }

  const selecionados = grupos.flatMap(g => (sel[g.id] ?? []).map(oid => {
    const o = g.opcoes.find(x => x.id === oid)
    return { grupoId: g.id, nome: o.nome, preco_adicional: Number(o.preco_adicional || 0) }
  }))
  const precoUnit = base + adicionalComplementos(
    grupos,
    selecionados.map(c => ({ grupoId: c.grupoId, preco: c.preco_adicional })),
  )
  // A loja pode liberar os obrigatórios no presencial (botão no Salão, mig 0121):
  // no atendimento na hora o mínimo deixa de travar.
  const faltando = semObrigatorios
    ? []
    : grupos.filter(g => (g.min ?? 0) > 0 && (sel[g.id]?.length ?? 0) < g.min)
  const pode = faltando.length === 0

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 25, display: 'flex', alignItems: 'flex-end' }}>
      {/* Só a lista rola: com 9 grupos, o botão de adicionar ficava lá no fim e
          o cliente tinha que descer tudo pra confirmar. */}
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#15102a', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '85dvh', display: 'flex', flexDirection: 'column', color: '#fff' }}>
        <div style={{ padding: '18px 18px 12px', borderBottom: '1px solid #2c2350', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
            <strong style={{ fontSize: 17 }}>{produto.nome}</strong>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, cursor: 'pointer' }}>×</button>
          </div>
          <p style={{ fontSize: 12.5, opacity: .7, margin: 0 }}>Monte do seu jeito 👇</p>
        </div>

        <div ref={corpoRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 4px' }}>
        {grupos.map(g => {
          const conta = sel[g.id]?.length ?? 0
          const falta = !semObrigatorios && (g.min ?? 0) > 0 && conta < g.min
          const pulouPraCa = destaque === g.id
          return (
            <div key={g.id} ref={el => { gruposRef.current[g.id] = el }} style={{
              marginBottom: 16, borderRadius: 12, transition: 'box-shadow .3s, background .3s',
              boxShadow: pulouPraCa ? '0 0 0 2px #7c3aed' : 'none',
              background: pulouPraCa ? 'rgba(124,58,237,.10)' : 'transparent',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong style={{ fontSize: 14 }}>{g.nome}</strong>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: falta ? '#7f1d1d' : '#2c2350', color: falta ? '#fecaca' : '#a78bfa' }}>
                  {g.max === 1 ? 'escolha 1' : `até ${g.max}`}{g.min > 0 && !semObrigatorios ? ' · obrigatório' : ''}
                </span>
              </div>
              {blocosDeOpcoes(g.opcoes).map(bloco => (
              <div key={bloco.titulo ?? 'unico'} style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: bloco.titulo ? 10 : 0 }}>
                {bloco.titulo && (
                  /* Cola no topo enquanto os sabores do bloco passam (o corpo do modal é
                     quem rola); margem negativa pra o fundo tampar as laterais. */
                  <p style={{
                    position: 'sticky', top: -14, zIndex: 3, margin: '0 -18px',
                    padding: '9px 18px 7px', background: '#15102a', boxShadow: '0 1px 0 #2c2350',
                    fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: .4, color: '#a89ec9',
                  }}>
                    {bloco.titulo}
                  </p>
                )}
                {bloco.opcoes.map(o => {
                  const marcado = (sel[g.id] ?? []).includes(o.id)
                  return (
                    <button key={o.id} onClick={() => toggle(g, o)} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                      padding: '10px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                      border: '1px solid ' + (marcado ? '#7c3aed' : '#2c2350'),
                      background: marcado ? 'rgba(124,58,237,.18)' : 'transparent', color: '#fff', fontSize: 14,
                    }}>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block' }}>{marcado ? '✓ ' : ''}{o.nomeCurto ?? o.nome}</span>
                        {o.descricao && (
                          <span style={{ display: 'block', fontSize: 12, lineHeight: 1.35, color: '#a89ec9', marginTop: 2 }}>{o.descricao}</span>
                        )}
                      </span>
                      {Number(o.preco_adicional) > 0 && <span style={{ color: '#a78bfa', fontSize: 13, flexShrink: 0 }}>+{fmt(o.preco_adicional)}</span>}
                    </button>
                  )
                })}
              </div>
              ))}
            </div>
          )
        })}
        </div>

        <div style={{
          flexShrink: 0, padding: '12px 18px calc(12px + env(safe-area-inset-bottom, 0px))',
          borderTop: '1px solid #2c2350', background: '#15102a',
        }}>
          <button onClick={() => pode && onConfirm(produto, selecionados, precoUnit)} disabled={!pode}
            style={{ width: '100%', height: 52, borderRadius: 14, border: 'none', cursor: pode ? 'pointer' : 'not-allowed',
              background: pode ? '#22c55e' : '#374151', color: '#fff', fontWeight: 800, fontSize: 15 }}>
            {pode ? `Adicionar · ${fmt(precoUnit)}` : `Escolha: ${faltando.map(g => g.nome).join(', ')}`}
          </button>
        </div>
      </div>
    </div>
  )
}
