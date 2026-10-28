import { useCallback, useEffect, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'

// Estoque por sabor (mig 0420). O sabor é uma opção de complemento ("Escolha o
// sabor") com estoque próprio: a venda baixa o sabor escolhido, zerou some do
// cardápio, deu entrada volta sozinho. Nasceu na CDBom (Picolé Cremoso: cada
// sabor acaba num dia). Só aparece pra loja que ligou em algum sabor.
export default function EstoqueSabores({ empresaId, dono }) {
  const [grupos, setGrupos] = useState([])
  const [aberto, setAberto] = useState(() => new Set())
  const [lancando, setLancando] = useState(null) // { opcao, modo: 'entrada'|'acertar' }
  const [qtd, setQtd] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    const { data: gs } = await supabase
      .from('complemento_grupos')
      .select('id, nome, complemento_opcoes(id, nome, ordem, disponivel, controla_estoque, pausado_por_estoque), produto_complemento_grupos(produtos(nome, arquivado_em))')
      .eq('empresa_id', empresaId)
    const comEstoque = (gs ?? [])
      .map((g) => ({ ...g, opcoes: (g.complemento_opcoes ?? []).filter((o) => o.controla_estoque) }))
      .filter((g) => g.opcoes.length > 0)
    if (comEstoque.length === 0) { setGrupos([]); return }

    const { data: movs } = await fetchAll(() => supabase
      .from('complemento_estoque_movimentos')
      .select('id, opcao_id, tipo, quantidade')
      .eq('empresa_id', empresaId)
      .order('id'))
    const saldo = {}
    for (const m of movs ?? []) {
      const q = Number(m.quantidade) || 0
      saldo[m.opcao_id] = (saldo[m.opcao_id] ?? 0) + (m.tipo === 'saida' ? -q : q)
    }

    setGrupos(comEstoque.map((g) => {
      // O grupo pode servir a mais de um produto (Delícia e a promoção da quarta):
      // o título é o nome mais curto, que é o produto "de verdade".
      const nomes = (g.produto_complemento_grupos ?? [])
        .map((x) => x.produtos).filter((p) => p && !p.arquivado_em).map((p) => p.nome)
        .sort((a, b) => a.length - b.length)
      const opcoes = g.opcoes
        .map((o) => ({ ...o, saldo: saldo[o.id] ?? 0 }))
        .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || a.nome.localeCompare(b.nome))
      return {
        id: g.id, titulo: nomes[0] ?? g.nome, opcoes,
        total: opcoes.reduce((s, o) => s + Math.max(o.saldo, 0), 0),
        zerados: opcoes.filter((o) => o.saldo <= 0).length,
      }
    }).sort((a, b) => a.titulo.localeCompare(b.titulo)))
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])

  async function salvar(e) {
    e.preventDefault()
    const n = Number(String(qtd).replace(',', '.'))
    if (!Number.isFinite(n) || n < 0 || (lancando.modo === 'entrada' && n === 0)) {
      setErro('Digite uma quantidade válida.')
      return
    }
    // Acertar = "contei e tem N": lança a diferença como ajuste.
    const delta = lancando.modo === 'entrada' ? n : n - lancando.opcao.saldo
    if (delta === 0) { setLancando(null); return }
    setSalvando(true)
    setErro(null)
    const { error } = await supabase.from('complemento_estoque_movimentos').insert({
      empresa_id: empresaId,
      opcao_id: lancando.opcao.id,
      tipo: lancando.modo === 'entrada' ? 'entrada' : 'ajuste',
      quantidade: delta,
      motivo: lancando.modo === 'entrada' ? 'compra' : 'contagem',
    })
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setLancando(null)
    setQtd('')
    carregar()
  }

  if (grupos.length === 0) return null

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>🍦 Estoque por sabor</h2>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>
        A venda baixa o sabor escolhido. Zerou, o sabor some do cardápio; deu entrada, ele volta sozinho.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {grupos.map((g) => {
          const abre = aberto.has(g.id)
          return (
            <div key={g.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <button type="button" aria-expanded={abre}
                onClick={() => setAberto((s) => { const n = new Set(s); n.has(g.id) ? n.delete(g.id) : n.add(g.id); return n })}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 14px', border: 'none', background: 'transparent', color: 'var(--text)', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 800, fontSize: 15 }}>{g.titulo}</span>
                  <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-muted)' }}>
                    {g.opcoes.length} sabores
                    {g.zerados > 0 && <b style={{ color: 'var(--danger, #dc2626)', marginLeft: 8 }}>⚠️ {g.zerados} sem estoque</b>}
                  </span>
                </span>
                <strong style={{ fontSize: 16, whiteSpace: 'nowrap' }}>{g.total.toLocaleString('pt-BR')} un</strong>
                <span style={{ fontSize: 14, color: 'var(--text-muted)', width: 14 }}>{abre ? '▾' : '▸'}</span>
              </button>
              {abre && (
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  {g.opcoes.map((o) => {
                    const zerado = o.saldo <= 0
                    const pausadoMao = o.disponivel === false && !o.pausado_por_estoque
                    return (
                      <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 14px', borderBottom: '1px solid var(--border)',
                        ...(zerado ? { background: 'rgba(220,38,38,.05)', boxShadow: 'inset 3px 0 0 #dc2626' } : {}) }}>
                        <span style={{ flex: '1 1 140px', minWidth: 0 }}>
                          <span style={{ display: 'block', fontWeight: 700 }}>{o.nome}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: zerado ? 'var(--danger, #dc2626)' : 'var(--text)' }}>
                            {o.saldo.toLocaleString('pt-BR')} un
                          </span>
                          {zerado && <span style={{ fontSize: 12, color: 'var(--danger, #dc2626)' }}> · fora do cardápio</span>}
                          {pausadoMao && <span style={{ fontSize: 12, color: '#b45309' }}> · pausado à mão</span>}
                        </span>
                        <button type="button" className="btn btn-primary" style={{ padding: '6px 12px' }}
                          onClick={() => { setLancando({ opcao: o, modo: 'entrada' }); setQtd(''); setErro(null) }}>
                          + Entrada
                        </button>
                        {dono && (
                          <button type="button" className="btn btn-secondary" style={{ padding: '6px 12px' }}
                            onClick={() => { setLancando({ opcao: o, modo: 'acertar' }); setQtd(String(Math.max(o.saldo, 0))); setErro(null) }}>
                            Acertar
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {lancando && (
        <div className="modal-overlay" onClick={() => setLancando(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{lancando.modo === 'entrada' ? 'Entrada' : 'Acertar estoque'} · {lancando.opcao.nome}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 0 }}>
              {lancando.modo === 'entrada'
                ? `Hoje: ${lancando.opcao.saldo.toLocaleString('pt-BR')} un. Quantas chegaram?`
                : 'Quantas tem agora, contando na mão?'}
            </p>
            <form onSubmit={salvar}>
              <div className="form-group">
                <input type="number" inputMode="numeric" min="0" step="1" autoFocus autoComplete="off"
                  value={qtd} onChange={(e) => setQtd(e.target.value)} placeholder="Quantidade" />
              </div>
              {erro && <p className="error-text">{erro}</p>}
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setLancando(null)}>Cancelar</button>
                <button type="submit" className="btn btn-primary" disabled={salvando}>
                  {salvando ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
