import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { recadoDeErro } from '../lib/erroRede'
import { ICONE_CATEGORIA } from '../lib/categoriasFinanceiro'
import '../components/Page.css'
import './ContasPagarReceberV2.css'

// HISTÓRICO DE ESTOQUE — o que entrou (compras lançadas…) e o que saiu (vendas, perdas…), por categoria.
//
// Pedido do AGV Grill (26/10/2026): ver, no mesmo estilo dos cartões de "Já pago", tudo o que mexeu no
// estoque. Lê as duas tabelas de movimento — estoque_movimentos (produtos do cardápio) e
// materia_prima_movimentos (insumos da ficha) — e junta. Produto agrupa pela categoria do CATÁLOGO
// (Bebidas, Picolé…); matéria-prima pela categoria do insumo (Carnes, Hortifruti…).
// Uma chave escolhe qual dos dois estoques ver (pedido do Wilde 27/10: misturar confundia o total).
//
// É LEITURA: nada aqui altera estoque. Quem lança entrada é "Lançar compra"; a saída acontece sozinha na venda.

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const qtdTxt = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const somaDias = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d) }
const primeiroDoMes = (s, deltaMes = 0) => { const d = new Date(`${s.slice(0, 7)}-01T12:00:00`); d.setMonth(d.getMonth() + deltaMes); return ymd(d) }
// Brasil não tem horário de verão desde 2019: -03:00 fixo.
const noInstante = (dia) => new Date(`${dia}T00:00:00-03:00`).toISOString()
const quandoTxt = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })

const MOTIVOS = {
  compra: 'Compra', venda: 'Venda', devolucao: 'Devolução', ajuste_inventario: 'Ajuste de inventário',
  bonificacao: 'Bonificação', perda: 'Perda', desperdicio: 'Desperdício', consumo: 'Consumo', contagem: 'Contagem de estoque',
}
const rotuloMotivo = (m, obs) => {
  if (m && MOTIVOS[m]) return MOTIVOS[m]
  if (m) return m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, ' ')
  return obs ? String(obs).slice(0, 40) : 'Movimento'
}
const CORES = ['#2563eb', '#0891b2', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#ca8a04', '#64748b']

export default function HistoricoEstoque({ empresaId }) {
  const [dados, setDados] = useState({ prod: [], mp: [], produtos: new Map(), materias: new Map(), pessoas: new Map() })
  const [agrupar, setAgrupar] = useState('categoria')  // 'categoria' | 'origem' (fornecedor / cozinha / contagem…)
  const [apagando, setApagando] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [periodo, setPeriodo] = useState('hoje')       // 'hoje' | '7d' | 'mes' | 'mes_passado' — abre em Hoje (pedido do AGV)
  const [aba, setAba] = useState('entrada')            // 'entrada' | 'saida'
  const [qual, setQual] = useState('produto')          // 'produto' (catálogo) | 'materia' (matéria-prima)
  const [aberto, setAberto] = useState(null)           // item aberto: `${origem}:${id}`

  const hoje = ymd(new Date())
  const [ini, fim] = useMemo(() => {
    if (periodo === 'hoje') return [hoje, somaDias(hoje, 1)]
    if (periodo === '7d') return [somaDias(hoje, -6), somaDias(hoje, 1)]
    if (periodo === 'mes_passado') return [primeiroDoMes(hoje, -1), primeiroDoMes(hoje, 0)]
    return [primeiroDoMes(hoje, 0), primeiroDoMes(hoje, 1)]
  }, [periodo, hoje])

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setCarregando(true)
    setErro(null)
    try {
      const de = noInstante(ini), ate = noInstante(fim)
      const [p, m, pr, mt, pe] = await Promise.all([
        fetchAll(() => supabase.from('estoque_movimentos')
          .select('id, produto_id, tipo, quantidade, motivo, observacao, custo_unit, valor_total, created_at, created_by, contagem_id')
          .eq('empresa_id', empresaId).gte('created_at', de).lt('created_at', ate).order('created_at', { ascending: false }).order('id')),
        fetchAll(() => supabase.from('materia_prima_movimentos')
          .select('id, materia_prima_id, tipo, quantidade, observacao, custo_unit, valor_total, created_at, created_by, contagem_id')
          .eq('empresa_id', empresaId).gte('created_at', de).lt('created_at', ate).order('created_at', { ascending: false }).order('id')),
        fetchAll(() => supabase.from('produtos').select('id, nome, categoria, preco_custo').eq('empresa_id', empresaId).order('id')),
        fetchAll(() => supabase.from('materias_primas').select('id, nome, unidade, custo, categoria').eq('empresa_id', empresaId).order('id')),
        supabase.from('profiles').select('id, nome, email').eq('empresa_id', empresaId),
      ])
      for (const r of [p, m, pr, mt]) if (r.error) throw r.error
      setDados({
        prod: p.data || [], mp: m.data || [],
        produtos: new Map((pr.data || []).map((x) => [x.id, x])),
        materias: new Map((mt.data || []).map((x) => [x.id, x])),
        pessoas: new Map((pe.data || []).map((x) => [x.id, (x.nome || '').trim() || x.email])),
      })
    } catch (e) {
      setErro(recadoDeErro(e, 'carregar o histórico de estoque'))
    } finally {
      setCarregando(false)
    }
  }, [empresaId, ini, fim])

  useEffect(() => { carregar() }, [carregar])

  // Uma lista só, com o sentido (entrou/saiu) já decidido. "ajuste" sem sentido no nome vale pelo sinal.
  const movs = useMemo(() => {
    const sentido = (tipo, q) => (tipo === 'entrada' ? 'entrada' : tipo === 'saida' ? 'saida' : (Number(q) >= 0 ? 'entrada' : 'saida'))
    const lista = []
    for (const x of dados.prod) {
      const it = dados.produtos.get(x.produto_id)
      const qtd = Math.abs(Number(x.quantidade))
      const unit = Number(x.custo_unit) || Number(it?.preco_custo) || 0
      lista.push({
        id: x.id, origem: 'produto', itemId: x.produto_id, nome: it?.nome || 'Produto apagado',
        grupo: it?.categoria && it.categoria !== 'outros' ? it.categoria : 'Sem categoria', emoji: '📦',
        unidade: 'un', dir: sentido(x.tipo, x.quantidade), qtd,
        valor: Number(x.valor_total) || qtd * unit, estimado: !(Number(x.valor_total) || Number(x.custo_unit)),
        motivo: rotuloMotivo(x.motivo, x.observacao), obs: x.observacao, quando: x.created_at,
        quem: dados.pessoas.get(x.created_by) || null, contagem: !!x.contagem_id, venda: x.motivo === 'venda',
      })
    }
    for (const x of dados.mp) {
      const it = dados.materias.get(x.materia_prima_id)
      const qtd = Math.abs(Number(x.quantidade))
      const unit = Number(x.custo_unit) || Number(it?.custo) || 0
      const dir = sentido(x.tipo, x.quantidade)
      lista.push({
        id: x.id, origem: 'materia', itemId: x.materia_prima_id, nome: it?.nome || 'Matéria-prima apagada',
        grupo: it?.categoria || 'Sem categoria', emoji: ICONE_CATEGORIA[it?.categoria] || '🥩', unidade: it?.unidade || 'un', dir, qtd,
        valor: Number(x.valor_total) || qtd * unit, estimado: !(Number(x.valor_total) || Number(x.custo_unit)),
        motivo: dir === 'entrada' && /compra/i.test(x.observacao || '') ? 'Compra' : rotuloMotivo(null, x.observacao),
        obs: x.observacao, quando: x.created_at,
        quem: dados.pessoas.get(x.created_by) || null, contagem: !!x.contagem_id, venda: false,
      })
    }
    // De onde veio / pra onde foi — o agrupamento "por fornecedor" da antiga aba Compras da Ficha Técnica.
    for (const m of lista) {
      const forn = /^Compra lançada — (.+)$/.exec(m.obs || '')?.[1]?.trim()
      const obs = m.obs || ''
      m.fonte = forn ? `🏪 ${forn}`
        : m.contagem ? '📋 Contagem de estoque'
        : /^Sobra da cozinha/.test(obs) ? '🍳 Sobra que voltou da cozinha'
        : /^Cozinha —/.test(obs) ? '🍳 Entregue à cozinha'
        : m.venda || /^Venda/i.test(obs) ? '🧾 Vendas'
        : '✍️ Lançado à mão'
      // Apagar aqui só o que foi lançado à mão. Compra, cozinha e contagem têm o "Desfazer" delas
      // (apagar a linha solta deixaria a nota, a entrega ou a contagem pela metade).
      m.apagavel = m.fonte === '✍️ Lançado à mão'
    }
    return lista.filter((m) => m.origem === qual)
  }, [dados, qual])

  async function apagar(m) {
    if (!window.confirm(`Apagar este lançamento?\n\n${m.nome} · ${m.dir === 'entrada' ? '+' : '−'}${qtdTxt(m.qtd)} ${m.unidade}${m.valor > 0 ? ` (${brl(m.valor)})` : ''}\n` +
      `Feito em ${quandoTxt(m.quando)}.\n\nO estoque volta ao que era antes dele.`)) return
    setApagando(m.id)
    const { error } = await supabase.from(m.origem === 'materia' ? 'materia_prima_movimentos' : 'estoque_movimentos').delete().eq('id', m.id)
    setApagando(null)
    if (error) { setErro(recadoDeErro(error, 'apagar o lançamento')); return }
    carregar()
  }

  const resumo = useMemo(() => {
    const soma = (dir) => {
      const l = movs.filter((m) => m.dir === dir)
      return { n: l.length, valor: l.reduce((s, m) => s + m.valor, 0), itens: new Set(l.map((m) => `${m.origem}:${m.itemId}`)).size }
    }
    return { entrada: soma('entrada'), saida: soma('saida') }
  }, [movs])

  // grupo (categoria) → item → movimentos
  const grupos = useMemo(() => {
    const mapa = new Map()
    for (const m of movs.filter((x) => x.dir === aba)) {
      const nomeGrupo = agrupar === 'origem' ? m.fonte.slice(m.fonte.indexOf(' ') + 1) : m.grupo
      const emoji = agrupar === 'origem' ? m.fonte.slice(0, m.fonte.indexOf(' ')) : m.emoji
      if (!mapa.has(nomeGrupo)) mapa.set(nomeGrupo, { grupo: nomeGrupo, emoji, valor: 0, itens: new Map() })
      const g = mapa.get(nomeGrupo)
      g.valor += m.valor
      const k = `${m.origem}:${m.itemId}`
      if (!g.itens.has(k)) g.itens.set(k, { key: k, nome: m.nome, unidade: m.unidade, qtd: 0, valor: 0, movs: [] })
      const i = g.itens.get(k)
      i.qtd += m.qtd; i.valor += m.valor; i.movs.push(m)
    }
    const total = [...mapa.values()].reduce((s, g) => s + g.valor, 0)
    return {
      total,
      lista: [...mapa.values()].map((g) => ({ ...g, itens: [...g.itens.values()].sort((a, b) => b.valor - a.valor || b.qtd - a.qtd) }))
        .sort((a, b) => b.valor - a.valor),
    }
  }, [movs, aba, agrupar])

  if (!empresaId) return <div className="card">Selecione uma loja.</div>
  const s = resumo[aba]

  return (
    <div className="cp2">
      <div className="cp2-topo">
        <div>
          <h2 className="cp2-titulo">Histórico de estoque</h2>
          <p className="cp2-sub">Tudo o que entrou e saiu do estoque, separado por categoria.</p>
        </div>
      </div>

      {erro && <div className="cpr-aviso cpr-aviso-erro">{erro} <button type="button" className="btn btn-secondary btn-sm" onClick={carregar}>Tentar de novo</button></div>}

      <div style={{ display: 'inline-flex', padding: 4, gap: 4, borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg-card, #fff)', marginBottom: 12 }}>
        {[['produto', '📦 Produtos'], ['materia', '🥩 Matérias-primas']].map(([id, lb]) => (
          <button key={id} type="button" onClick={() => { setQual(id); setAberto(null) }} aria-pressed={qual === id}
            style={{ padding: '8px 16px', borderRadius: 999, border: 0, cursor: 'pointer', fontSize: 14, fontWeight: 700,
              background: qual === id ? 'var(--primary)' : 'transparent', color: qual === id ? '#fff' : 'var(--text-muted)' }}>
            {lb}
          </button>
        ))}
      </div>

      <div className="cp2-periodo">
        {[['hoje', 'Hoje'], ['7d', 'Últimos 7 dias'], ['mes', 'Este mês'], ['mes_passado', 'Mês passado']].map(([id, lb]) => (
          <button key={id} type="button" className={`cp2-chip ${periodo === id ? 'ativo' : ''}`} onClick={() => { setPeriodo(id); setAberto(null) }}>{lb}</button>
        ))}
      </div>

      <div className="cp2-cards cp2-cards-2">
        <button type="button" className={`cp2-card cp2-card-receber ${aba === 'entrada' ? 'ativo' : ''}`} onClick={() => setAba('entrada')}>
          <span className="cp2-card-rotulo">⬇️ Entrou</span>
          <span className="cp2-card-valor">{brl(resumo.entrada.valor)}</span>
          <span className="cp2-card-nota">{resumo.entrada.itens} {resumo.entrada.itens === 1 ? 'item' : 'itens'} · {resumo.entrada.n} {resumo.entrada.n === 1 ? 'entrada' : 'entradas'}</span>
        </button>
        <button type="button" className={`cp2-card cp2-card-pagar ${aba === 'saida' ? 'ativo' : ''}`} onClick={() => setAba('saida')}>
          <span className="cp2-card-rotulo">⬆️ Saiu</span>
          <span className="cp2-card-valor">{brl(resumo.saida.valor)}</span>
          <span className="cp2-card-nota">{resumo.saida.itens} {resumo.saida.itens === 1 ? 'item' : 'itens'} · {resumo.saida.n} {resumo.saida.n === 1 ? 'saída' : 'saídas'} · pelo custo</span>
        </button>
      </div>

      {carregando ? (
        <div className="skeleton" style={{ height: 140 }} />
      ) : grupos.lista.length === 0 ? (
        <div className="card cpr-vazio cpr-vazio-pequeno">
          <div className="cpr-vazio-icone">{aba === 'entrada' ? '📥' : '📤'}</div>
          <p>{aba === 'entrada' ? 'Nenhuma entrada' : 'Nenhuma saída'} de {qual === 'materia' ? 'matéria-prima' : 'produto'} nesse período.</p>
        </div>
      ) : (
        <>
          <div className="cp2-periodo" style={{ marginTop: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Separar por</span>
            {[['categoria', 'Categoria'], ['origem', aba === 'entrada' ? 'Fornecedor / de onde veio' : 'Pra onde foi']].map(([id, lb]) => (
              <button key={id} type="button" className={`cp2-chip ${agrupar === id ? 'ativo' : ''}`} onClick={() => { setAgrupar(id); setAberto(null) }}>{lb}</button>
            ))}
            <span className="cp2-periodo-total">{aba === 'entrada' ? 'Total que entrou' : 'Custo do que saiu'} <strong>{brl(s.valor)}</strong></span>
          </div>
          <div className="cp2-familias">
            {grupos.lista.map((g, idx) => {
              const cor = CORES[idx % CORES.length]
              const pct = grupos.total > 0 ? (g.valor / grupos.total) * 100 : 0
              return (
                <section key={g.grupo} className="cp2-familia" style={{ '--fam': cor }}>
                  <header className="cp2-familia-topo">
                    <span className="cp2-bolha-grande">{g.emoji}</span>
                    <div className="cp2-familia-nome">
                      <strong>{g.grupo}</strong>
                      <span>{g.itens.length} {g.itens.length === 1 ? 'item' : 'itens'}</span>
                    </div>
                    <div className="cp2-familia-valor">
                      <strong>{brl(g.valor)}</strong>
                      <span>{pct.toFixed(0)}% do total</span>
                    </div>
                  </header>
                  <div className="cp2-barra"><i style={{ width: `${Math.max(2, pct)}%` }} /></div>
                  <ul className="cp2-cats">
                    {g.itens.map((i) => {
                      const ab = aberto === i.key
                      return (
                        <li key={i.key}>
                          <button type="button" className={`cp2-cat cp2-cat-estoque ${ab ? 'aberta' : ''}`} onClick={() => setAberto(ab ? null : i.key)} aria-expanded={ab}>
                            <span className="cp2-cat-seta">{ab ? '▾' : '▸'}</span>
                            <span className="cp2-cat-nome">{i.nome}</span>
                            <span className="cp2-cat-qtd">{qtdTxt(i.qtd)} {i.unidade}</span>
                            <span className="cp2-cat-valor">{brl(i.valor)}</span>
                          </button>
                          {ab && (
                            <ul className="ce-movs">
                              {i.movs.slice(0, 40).map((m) => (
                                <li key={`${m.origem}${m.id}`}>
                                  <span className="ce-quando">{quandoTxt(m.quando)}</span>
                                  <span className="ce-motivo">{m.motivo}</span>
                                  <span className="ce-qtd">{m.dir === 'entrada' ? '+' : '−'}{qtdTxt(m.qtd)}</span>
                                  <span className="ce-valor">{m.valor > 0 ? brl(m.valor) : '—'}{m.estimado && m.valor > 0 ? '*' : ''}</span>
                                  {m.apagavel && (
                                    <button type="button" onClick={() => apagar(m)} disabled={apagando === m.id} title="Apagar (lancei errado)"
                                      style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 15, padding: '0 4px' }}>
                                      {apagando === m.id ? '…' : '🗑'}
                                    </button>
                                  )}
                                  {(m.obs && m.motivo !== m.obs) || m.quem ? (
                                    <span className="ce-obs" title={m.obs || ''}>{[m.obs && m.motivo !== m.obs ? m.obs : null, m.quem ? `por ${m.quem}` : null].filter(Boolean).join(' · ')}</span>
                                  ) : null}
                                </li>
                              ))}
                              {i.movs.length > 40 && <li className="ce-mais">e mais {i.movs.length - 40} movimentos…</li>}
                            </ul>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
          </div>
        </>
      )}

      <p className="cp2-rodape">
        ℹ️ <strong>Entrou</strong> = compras lançadas, devoluções e ajustes. <strong>Saiu</strong> = vendas e perdas, valorizadas pelo <strong>custo</strong> do produto
        (não pelo preço de venda). Valor com <strong>*</strong> é estimado pelo custo do cadastro, porque o movimento não guardou o preço pago.
      </p>
    </div>
  )
}
