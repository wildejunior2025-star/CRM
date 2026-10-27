import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { recadoDeErro } from '../lib/erroRede'
import { CATEGORIAS_INSUMO } from '../lib/categoriasFinanceiro'
import { useCategoriasInsumo } from '../hooks/useCategoriasInsumo'
import '../components/Page.css'

// CONTAGEM DE ESTOQUE — o dono conta o que tem na prateleira e o sistema acerta o saldo de uma vez.
//
// AGV Grill (27/10/2026): a Conferência do mês só fecha com o estoque CONTADO no começo e no fim do mês.
// Ele conta pelo celular, andando no almoxarifado: abre a categoria, digita o que contou, grava.
//   * item em branco não é contado nem mexido (dá pra contar insumo hoje e bebida amanhã);
//   * o que já foi digitado fica guardado no aparelho até gravar (a contagem é longa e o telefone toca);
//   * o banco grava só a diferença, datada no começo do dia (mig 0416, registrar_contagem): a contagem do
//     dia 1º vira o estoque do fim do mês anterior e do início do mês novo.

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const qtdTxt = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 })
const num = (s) => { const n = Number(String(s ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN }
const vazio = (s) => String(s ?? '').trim() === ''
const r2 = (n) => Math.round(n * 100) / 100
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const quando = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })
const chaveRascunho = (emp) => `contagem-estoque:${emp}`

const cartao = { background: 'var(--bg-card, var(--card, #fff))', border: '1px solid var(--border)', borderRadius: 14 }
const campo = { padding: '10px 10px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 17, width: 92, textAlign: 'right' }
const pilula = (on) => ({ padding: '9px 14px', borderRadius: 999, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 14, fontWeight: 700,
  background: on ? 'var(--primary)' : 'transparent', color: on ? '#fff' : 'var(--text)' })

export default function ContagemEstoque({ empresaId }) {
  const { icone } = useCategoriasInsumo(empresaId)
  const [insumos, setInsumos] = useState([])
  const [produtos, setProdutos] = useState([])
  const [ultima, setUltima] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [aba, setAba] = useState('mp')            // 'mp' insumos | 'prod' revenda
  const [busca, setBusca] = useState('')
  const [catAberta, setCatAberta] = useState(null)
  const [salvando, setSalvando] = useState(false)
  // { 'mp:<id>': '12,5', 'prod:<id>': '24' } — o que já foi digitado
  const [contado, setContado] = useState({})
  const [rascunhoDe, setRascunhoDe] = useState(null)   // de qual loja o rascunho já foi lido (só grava depois de ler)

  useEffect(() => {
    if (!empresaId) return
    let r = {}
    try { r = JSON.parse(localStorage.getItem(chaveRascunho(empresaId)) || '{}') || {} } catch { /* sem rascunho */ }
    setContado(r)
    setRascunhoDe(empresaId)
  }, [empresaId])

  useEffect(() => {
    if (!empresaId || rascunhoDe !== empresaId) return
    try {
      const temAlgo = Object.values(contado).some(v => !vazio(v))
      if (temAlgo) localStorage.setItem(chaveRascunho(empresaId), JSON.stringify(contado))
      else localStorage.removeItem(chaveRascunho(empresaId))
    } catch { /* aparelho sem armazenamento: só não guarda */ }
  }, [contado, empresaId, rascunhoDe])

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setCarregando(true)
    setErro(null)
    try {
      const [m, p, comEntrada, sp, u] = await Promise.all([
        fetchAll(() => supabase.from('materia_prima_saldo').select('materia_prima_id, nome, unidade, custo, quantidade_atual, categoria').order('materia_prima_id')),
        fetchAll(() => supabase.from('produtos').select('id, nome, categoria, preco_custo, ativo, pausado_por_estoque, controla_estoque')
          .eq('empresa_id', empresaId).order('id')),
        // Revenda = o que a loja COMPRA pronto (já teve entrada). Prato feito na cozinha não se conta na prateleira.
        fetchAll(() => supabase.from('estoque_movimentos').select('produto_id').eq('empresa_id', empresaId).eq('tipo', 'entrada').order('id')),
        fetchAll(() => supabase.from('estoque_saldo').select('produto_id, quantidade_atual').order('produto_id')),
        supabase.from('contagens_estoque').select('*').eq('empresa_id', empresaId).order('feita_em', { ascending: false }).limit(1),
      ])
      for (const r of [m, p, comEntrada, sp]) if (r.error) throw r.error
      const saldo = new Map((sp.data || []).map(x => [x.produto_id, Number(x.quantidade_atual || 0)]))
      const revenda = new Set((comEntrada.data || []).map(x => x.produto_id))
      setInsumos((m.data || []).map(x => ({ id: x.materia_prima_id, nome: x.nome, unidade: x.unidade || 'un', custo: Number(x.custo || 0),
        saldo: Number(x.quantidade_atual || 0), categoria: x.categoria || 'Sem categoria' })))
      setProdutos((p.data || [])
        .filter(x => revenda.has(x.id) && x.controla_estoque !== false && (x.ativo !== false || x.pausado_por_estoque))
        .map(x => ({ id: x.id, nome: x.nome, unidade: 'un', custo: Number(x.preco_custo || 0), saldo: saldo.get(x.id) ?? 0, categoria: x.categoria || 'Sem categoria' })))
      setUltima(u.error ? null : (u.data?.[0] || null))
    } catch (e) {
      setErro(recadoDeErro(e, 'carregar o estoque'))
    } finally {
      setCarregando(false)
    }
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])

  const lista = aba === 'mp' ? insumos : produtos
  const chave = (it) => `${aba}:${it.id}`

  const grupos = useMemo(() => {
    const q = norm(busca).trim()
    const mapa = new Map()
    for (const it of lista) {
      if (q && !norm(it.nome).includes(q)) continue
      if (!mapa.has(it.categoria)) mapa.set(it.categoria, [])
      mapa.get(it.categoria).push(it)
    }
    const ordem = aba === 'mp' ? [...CATEGORIAS_INSUMO, 'Sem categoria'] : []
    return [...mapa.entries()]
      .map(([cat, itens]) => ({ cat, itens: itens.sort((a, b) => a.nome.localeCompare(b.nome)) }))
      .sort((a, b) => ((ordem.indexOf(a.cat) + 1) || 99) - ((ordem.indexOf(b.cat) + 1) || 99) || a.cat.localeCompare(b.cat))
  }, [lista, busca, aba])

  // Tudo que foi digitado (das duas abas), já com a diferença pro sistema.
  const digitados = useMemo(() => {
    const out = []
    for (const [tipo, itens] of [['mp', insumos], ['prod', produtos]]) {
      for (const it of itens) {
        const v = contado[`${tipo}:${it.id}`]
        if (vazio(v)) continue
        const n = num(v)
        out.push({ tipo, it, n, valido: Number.isFinite(n) && n >= 0, dif: Number.isFinite(n) ? n - it.saldo : 0 })
      }
    }
    return out
  }, [contado, insumos, produtos])
  const invalidos = digitados.filter(d => !d.valido)
  const difValor = r2(digitados.filter(d => d.valido).reduce((s, d) => s + d.dif * d.it.custo, 0))
  const contadosNaAba = (tipo) => digitados.filter(d => d.tipo === tipo).length

  const muda = (it, v) => setContado(c => ({ ...c, [chave(it)]: v }))

  async function gravar() {
    setErro(null); setAviso(null)
    if (!digitados.length) { setErro('Digite a quantidade de pelo menos um item.'); return }
    if (invalidos.length) { setErro(`Quantidade inválida em: ${invalidos.map(d => d.it.nome).join(', ')}.`); return }
    const mudam = digitados.filter(d => Math.abs(d.dif) > 0.0005).length
    if (!window.confirm(`Gravar a contagem de ${digitados.length} ite${digitados.length > 1 ? 'ns' : 'm'}?\n\n` +
      `${mudam} ficam diferentes do que o sistema tinha (${difValor >= 0 ? 'sobrando' : 'faltando'} ${brl(Math.abs(difValor))}).\n\n` +
      'O que você não digitou não muda.')) return
    setSalvando(true)
    try {
      const { data, error } = await supabase.rpc('registrar_contagem', {
        p: { itens: digitados.map(d => ({ tipo: d.tipo, id: d.it.id, contado: d.n })) },
      })
      if (error) throw error
      setContado({})
      setAviso(`Contagem gravada: ${data.itens} itens, estoque contado vale ${brl(data.valor_contado)}.`)
      await carregar()
    } catch (e) {
      setErro(recadoDeErro(e, 'gravar a contagem'))
    } finally {
      setSalvando(false)
    }
  }

  async function desfazer() {
    if (!ultima) return
    if (!window.confirm(`Desfazer a contagem de ${quando(ultima.feita_em)} (${ultima.itens} itens)?\n\nO estoque volta a ser o que era antes dela.`)) return
    const { error } = await supabase.rpc('desfazer_contagem', { p_id: ultima.id })
    if (error) { setErro(recadoDeErro(error, 'desfazer a contagem')); return }
    setAviso('Contagem desfeita.')
    carregar()
  }

  const limpar = () => { if (window.confirm('Apagar tudo que você digitou e ainda não gravou?')) setContado({}) }

  if (carregando && !insumos.length && !produtos.length) return <div style={{ ...cartao, padding: 14 }}>Carregando o estoque…</div>

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ ...cartao, padding: 14, marginBottom: 12, fontSize: 14 }}>
        <b style={{ fontSize: 16 }}>📋 Contar o estoque</b>
        <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
          Conte o que tem agora na prateleira e digite. O que ficar em branco não muda. Faça no <b>dia 1º, antes de abrir</b>: vira o estoque do fim do mês que passou e do começo do mês novo.
        </div>
        {ultima && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              Última contagem: <b>{quando(ultima.feita_em)}</b>{ultima.feita_por_nome ? ` por ${ultima.feita_por_nome}` : ''} — {ultima.itens} itens,{' '}
              {Number(ultima.valor_diferenca) === 0 ? 'tudo batia' : <b style={{ color: ultima.valor_diferenca < 0 ? 'var(--danger, #dc2626)' : 'var(--success, #16a34a)' }}>
                {ultima.valor_diferenca < 0 ? 'faltou' : 'sobrou'} {brl(Math.abs(ultima.valor_diferenca))}</b>}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={desfazer}>Desfazer</button>
          </div>
        )}
      </div>

      {erro && <div className="alert alert-error" style={{ marginBottom: 12 }}>{erro}</div>}
      {aviso && <div className="alert alert-success" style={{ marginBottom: 12 }}>{aviso}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <button type="button" style={pilula(aba === 'mp')} onClick={() => { setAba('mp'); setCatAberta(null) }}>
          🥩 Insumos {contadosNaAba('mp') > 0 && `(${contadosNaAba('mp')}/${insumos.length})`}
        </button>
        <button type="button" style={pilula(aba === 'prod')} onClick={() => { setAba('prod'); setCatAberta(null) }}>
          🥤 Revenda {contadosNaAba('prod') > 0 && `(${contadosNaAba('prod')}/${produtos.length})`}
        </button>
      </div>

      <input type="search" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar item…"
        style={{ ...campo, width: '100%', textAlign: 'left', marginBottom: 10, boxSizing: 'border-box' }} />

      {!grupos.length && <div style={{ ...cartao, padding: 14, color: 'var(--text-muted)' }}>
        {busca ? 'Nada com esse nome.' : aba === 'mp' ? 'Nenhum insumo cadastrado.' : 'Nenhum produto de revenda (só aparece o que já teve compra lançada).'}
      </div>}

      {grupos.map(({ cat, itens }) => {
        const aberto = !!busca || catAberta === cat
        const feitos = itens.filter(it => !vazio(contado[chave(it)])).length
        return (
          <div key={cat} style={{ ...cartao, marginBottom: 10, overflow: 'hidden' }}>
            <button type="button" onClick={() => setCatAberta(aberto && !busca ? null : cat)}
              style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '14px 14px', background: 'transparent', border: 0, color: 'var(--text)', cursor: 'pointer', fontSize: 16, fontWeight: 800, textAlign: 'left' }}>
              <span>{icone(cat)} {cat}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: feitos === itens.length ? 'var(--success, #16a34a)' : 'var(--text-muted)' }}>
                {feitos}/{itens.length} {feitos === itens.length ? '✓' : ''} {aberto ? '▲' : '▼'}
              </span>
            </button>
            {aberto && itens.map(it => {
              const v = contado[chave(it)] ?? ''
              const n = num(v)
              const dif = !vazio(v) && Number.isFinite(n) ? r2(n - it.saldo) : null
              return (
                <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{it.nome}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                      sistema: {qtdTxt(it.saldo)} {it.unidade}
                      {it.custo <= 0 && <span style={{ color: '#b45309' }}> · sem custo</span>}
                      {dif !== null && dif !== 0 && (
                        <b style={{ color: dif < 0 ? 'var(--danger, #dc2626)' : 'var(--success, #16a34a)' }}>
                          {' '}· {dif < 0 ? 'faltam' : 'sobram'} {qtdTxt(Math.abs(dif))} {it.unidade}{it.custo > 0 ? ` (${brl(Math.abs(dif * it.custo))})` : ''}
                        </b>
                      )}
                      {dif === 0 && <b style={{ color: 'var(--success, #16a34a)' }}> · bateu</b>}
                    </div>
                  </div>
                  <input inputMode="decimal" value={v} onChange={e => muda(it, e.target.value)} placeholder={it.unidade}
                    aria-label={`Quantidade contada de ${it.nome}`}
                    style={{ ...campo, borderColor: !vazio(v) && !(Number.isFinite(n) && n >= 0) ? 'var(--danger, #dc2626)' : 'var(--border)' }} />
                </div>
              )
            })}
          </div>
        )
      })}

      <div style={{ ...cartao, padding: 14, marginTop: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
          <span>Itens contados</span><b>{digitados.length}</b>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
          <b>Faltam</b> = você contou menos do que o sistema achava (gastou, perdeu ou saiu sem registrar). <b>Sobram</b> = contou mais (entrou sem lançar a compra). A contagem não é compra: compra se lança em 🛒 Lançar compra, a qualquer hora.
        </div>
        {digitados.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginTop: 4 }}>
            <span>Diferença pro sistema</span>
            <b style={{ color: difValor < 0 ? 'var(--danger, #dc2626)' : difValor > 0 ? 'var(--success, #16a34a)' : 'inherit' }}>
              {difValor === 0 ? 'bateu' : `${difValor < 0 ? 'faltando' : 'sobrando'} ${brl(Math.abs(difValor))}`}
            </b>
          </div>
        )}
        <button type="button" className="btn btn-primary" disabled={salvando || !digitados.length} onClick={gravar}
          style={{ width: '100%', marginTop: 12, padding: '14px', fontSize: 16 }}>
          {salvando ? 'Gravando…' : `✅ Gravar contagem${digitados.length ? ` (${digitados.length})` : ''}`}
        </button>
        {digitados.length > 0 && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={limpar} style={{ width: '100%', marginTop: 8 }}>
            Apagar o que digitei
          </button>
        )}
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>
          O que você digita fica guardado neste aparelho até gravar — pode parar e continuar depois.
        </div>
      </div>
    </div>
  )
}
