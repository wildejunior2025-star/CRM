import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { acharPorCodigo, combinaCodigo, ouvirBipada } from '../lib/codigoBarras'
import { recadoDeErro } from '../lib/erroRede'
import '../components/Page.css'

// ENTRADA DE ESTOQUE — a tela de receber mercadoria.
//
// POR QUE ELA EXISTE: o estoque das lojas morreu de burocracia. Entrada de
// compra foi lançada 46 vezes na vida inteira e parou em 25/08/2026. A tela de
// Estoque pede um modal POR PRODUTO, com cinco campos cada. Quem recebe uma
// carga de trinta itens não faz isso trinta vezes — e não fez.
//
// Aqui é o contrário: uma busca só, que também aceita BIPADA do leitor, e cada
// item cai numa lista que vai crescendo. Salva tudo de uma vez, no fim.
//
// ENTRADA SÓ, DE PROPÓSITO (decisão do usuário, 10/10/2026): saída sai sozinha
// na venda, e tirar do estoque sem vender é desperdício — que se registra no
// Financeiro, no portal, onde vira custo e tem que dizer o que aconteceu.
// Somar estoque não esconde furo; tirar esconde. Por isso esta, que fica no
// domínio do gestor (onde a operação trabalha), só sabe somar.
const num = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function EntradaEstoque() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  const [produtos, setProdutos] = useState([])
  const [usaEstoque, setUsaEstoque] = useState(true)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [busca, setBusca] = useState('')
  const [linhas, setLinhas] = useState([]) // [{ produto_id, nome, quantidade, custo }]
  const [atualizarCusto, setAtualizarCusto] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [salvo, setSalvo] = useState(null)
  const buscaRef = useRef(null)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setCarregando(true)
    setErro(null)
    try {
      const [pr, emp] = await Promise.all([
        fetchAll(() => supabase.from('produtos')
          .select('id, nome, preco_custo, codigo_barras, categoria, controla_estoque')
          .eq('empresa_id', empresaId).eq('ativo', true).is('arquivado_em', null)
          .order('nome').order('id')),
        supabase.from('empresas').select('estoque_ativo').eq('id', empresaId).maybeSingle(),
      ])
      if (pr.error) throw pr.error
      // Só produto que controla estoque: dar entrada em quem não controla cria
      // um saldo que não aparece em tela nenhuma.
      setProdutos((pr.data || []).filter(p => p.controla_estoque !== false))
      setUsaEstoque(emp.data?.estoque_ativo !== false)
    } catch (e) {
      setErro(recadoDeErro(e, 'carregar os produtos'))
    } finally {
      setCarregando(false)
    }
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])

  // Põe o produto na lista. Bipar o mesmo código de novo soma mais um, que é o
  // que a pessoa faz naturalmente ao conferir caixa por caixa.
  const somar = useCallback((produto, quanto = 1) => {
    if (!produto) return
    setSalvo(null)
    setLinhas(prev => {
      const i = prev.findIndex(l => l.produto_id === produto.id)
      if (i >= 0) {
        const copia = [...prev]
        copia[i] = { ...copia[i], quantidade: String(num(copia[i].quantidade) + quanto) }
        return copia
      }
      return [...prev, {
        produto_id: produto.id,
        nome: produto.nome,
        quantidade: String(quanto),
        custo: produto.preco_custo ? String(produto.preco_custo).replace('.', ',') : '',
      }]
    })
  }, [])

  // Leitor USB é teclado: bipar com o cursor fora de campo nenhum cai aqui.
  useEffect(() => {
    if (!produtos.length) return
    return ouvirBipada((codigo) => {
      const p = acharPorCodigo(produtos, codigo)
      if (p) { somar(p, 1); setBusca('') }
      else setErro(`Código ${codigo} não está em nenhum produto.`)
    })
  }, [produtos, somar])

  const achados = useMemo(() => {
    const t = busca.trim().toLowerCase()
    if (!t) return []
    return produtos
      .filter(p => p.nome.toLowerCase().includes(t) || combinaCodigo(p, busca))
      .slice(0, 8)
  }, [busca, produtos])

  function mudarLinha(id, campo, valor) {
    setLinhas(prev => prev.map(l => (l.produto_id === id ? { ...l, [campo]: valor } : l)))
  }
  function tirarLinha(id) {
    setLinhas(prev => prev.filter(l => l.produto_id !== id))
  }

  // Enter com UM resultado na busca adiciona direto — é o fluxo de quem digita
  // "coca" e já quer seguir pro próximo item sem tirar a mão do teclado.
  function teclaNaBusca(e) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const p = acharPorCodigo(produtos, busca) || (achados.length === 1 ? achados[0] : null)
    if (p) { somar(p, 1); setBusca(''); buscaRef.current?.focus() }
  }

  const totalItens = linhas.reduce((s, l) => s + num(l.quantidade), 0)
  const totalValor = linhas.reduce((s, l) => s + num(l.quantidade) * num(l.custo), 0)
  const temInvalida = linhas.some(l => num(l.quantidade) <= 0)

  async function salvar() {
    if (!linhas.length || temInvalida) return
    setSalvando(true)
    setErro(null)
    try {
      const movimentos = linhas.map(l => ({
        empresa_id: empresaId,
        produto_id: l.produto_id,
        tipo: 'entrada',
        quantidade: num(l.quantidade),
        motivo: 'compra',
        observacao: 'Entrada pelo gestor',
        custo_unit: num(l.custo) > 0 ? num(l.custo) : null,
        valor_total: num(l.custo) > 0 ? num(l.custo) * num(l.quantidade) : null,
      }))
      const { error } = await supabase.from('estoque_movimentos').insert(movimentos)
      if (error) throw error

      // O custo do cadastro é o que faz a conta de lucro bater. Quem acabou de
      // pagar a nota sabe o preço de hoje — não aproveitar isso aqui é deixar o
      // lucro ser calculado com o custo do mês passado.
      if (atualizarCusto) {
        for (const l of linhas) {
          const c = num(l.custo)
          if (c > 0) await supabase.from('produtos').update({ preco_custo: c }).eq('id', l.produto_id)
        }
      }

      setSalvo({ itens: linhas.length, unidades: totalItens })
      setLinhas([])
      buscaRef.current?.focus()
    } catch (e) {
      setErro(recadoDeErro(e, 'salvar a entrada'))
    } finally {
      setSalvando(false)
    }
  }

  if (!empresaId) return <div className="card">Selecione uma loja.</div>

  return (
    <div>
      <div className="page-header">
        <h1>Entrada de estoque</h1>
      </div>

      {!usaEstoque && (
        <div className="card" style={{ borderColor: '#f59e0b' }}>
          ⚠️ Esta loja está com o controle de estoque <strong>desligado</strong>. Dá pra lançar,
          mas nada vai ser contado até religar em Estoque.
        </div>
      )}

      {erro && (
        <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>
          {erro}
        </div>
      )}

      {salvo && (
        <div className="card" style={{ borderColor: '#22c55e' }}>
          ✅ Entrada salva: <strong>{salvo.itens}</strong> {salvo.itens === 1 ? 'produto' : 'produtos'},{' '}
          <strong>{salvo.unidades}</strong> no total. Pode continuar lançando.
        </div>
      )}

      <div className="card">
        <label style={{ fontSize: 13, fontWeight: 700, display: 'block', marginBottom: 6 }}>
          Buscar ou bipar o produto
        </label>
        <input
          ref={buscaRef}
          autoFocus
          value={busca}
          onChange={e => setBusca(e.target.value)}
          onKeyDown={teclaNaBusca}
          placeholder="Digite o nome ou passe o leitor…"
          style={{ width: '100%', fontSize: 16, padding: '12px 14px' }}
          disabled={carregando}
        />
        {carregando && <div style={{ fontSize: 12, marginTop: 8, opacity: .7 }}>Carregando produtos…</div>}

        {achados.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {achados.map(p => (
              <button key={p.id} type="button" className="btn btn-secondary"
                onClick={() => { somar(p, 1); setBusca(''); buscaRef.current?.focus() }}
                style={{ justifyContent: 'space-between', display: 'flex', textAlign: 'left', padding: '11px 12px' }}>
                <span>{p.nome}</span>
                <span style={{ opacity: .7, fontSize: 12 }}>{p.categoria || ''}</span>
              </button>
            ))}
          </div>
        )}

        {!carregando && !produtos.length && (
          <div style={{ fontSize: 12.5, marginTop: 10, opacity: .8 }}>
            Nenhum produto com controle de estoque ligado. Ligue no cadastro do produto,
            em Produtos, pra ele aparecer aqui.
          </div>
        )}
      </div>

      {linhas.length > 0 && (
        <div className="card">
          <div style={{ fontWeight: 800, marginBottom: 10 }}>
            Entrando ({linhas.length} {linhas.length === 1 ? 'produto' : 'produtos'})
          </div>

          {linhas.map(l => (
            <div key={l.produto_id}
              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
                padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: '1 1 160px', minWidth: 0, fontSize: 14, fontWeight: 600 }}>{l.nome}</div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button type="button" className="btn btn-secondary btn-sm"
                  onClick={() => mudarLinha(l.produto_id, 'quantidade', String(Math.max(0, num(l.quantidade) - 1)))}>−</button>
                <input inputMode="decimal" value={l.quantidade}
                  onChange={e => mudarLinha(l.produto_id, 'quantidade', e.target.value)}
                  style={{ width: 70, textAlign: 'center', fontSize: 15, padding: '8px 4px' }} />
                <button type="button" className="btn btn-secondary btn-sm"
                  onClick={() => mudarLinha(l.produto_id, 'quantidade', String(num(l.quantidade) + 1))}>+</button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 12, opacity: .7 }}>custo</span>
                <input inputMode="decimal" placeholder="opcional" value={l.custo}
                  onChange={e => mudarLinha(l.produto_id, 'custo', e.target.value)}
                  style={{ width: 92, fontSize: 14, padding: '8px 6px' }} />
              </div>

              <button type="button" className="btn btn-secondary btn-sm"
                onClick={() => tirarLinha(l.produto_id)} aria-label={`Tirar ${l.nome}`}>✕</button>
            </div>
          ))}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={atualizarCusto} onChange={e => setAtualizarCusto(e.target.checked)} />
            Atualizar o custo do cadastro com o que eu digitei
          </label>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13 }}>
              <strong>{totalItens}</strong> no total
              {totalValor > 0 && <> · <strong>{brl(totalValor)}</strong></>}
            </div>
            <button className="btn btn-primary" onClick={salvar} disabled={salvando || temInvalida}>
              {salvando ? 'Salvando…' : 'Salvar entrada'}
            </button>
          </div>
          {temInvalida && (
            <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 8 }}>
              Tem item com quantidade zerada — ajuste ou tire da lista.
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ fontSize: 12.5, opacity: .85 }}>
        Aqui só entra mercadoria. A saída acontece sozinha quando a venda é feita —
        e o que se perdeu sem vender (derreteu, caiu, venceu) entra como
        <strong> desperdício</strong>, no Financeiro, pra virar custo do dia.
      </div>
    </div>
  )
}
