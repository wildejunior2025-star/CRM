import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// ============================================================================
// ONDE CADA ITEM DO IFOOD VAI SAIR (23/10/2026)
//
// O app da impressora descobre o setor de um item pelo NOME, comparando com os
// nossos produtos. Isso basta na mesa, onde tudo é lançado do nosso catálogo.
// No iFood não: o cardápio mora lá e é escrito como o lojista quiser. No Agv
// são duas lojas no iFood, e a mesma coisa aparece como "Filé à parmegiana de
// frango" numa e "File parmegiana de frango" na outra.
//
// Item que não casava caía em "salão" — ou seja, NÃO SAÍA na comanda da
// cozinha. Sem erro, sem aviso. Com a cozinha longe do balcão, é prato que
// ninguém preparou.
//
// Esta tela é o conserto: liga a CATEGORIA de lá a uma categoria daqui. Por
// categoria e não por produto porque são ~13 contra 80 itens, e porque item
// novo criado lá dentro de uma categoria já conhecida entra roteado sozinho,
// sem ninguém manter lista nenhuma.
// ============================================================================
const RED = '#ea1d2c'

const ROTULO_SETOR = { cozinha: 'Cozinha', nenhum: 'Não imprime', salao: 'Frente / salão' }
const COR_SETOR = { cozinha: '#16a34a', nenhum: '#6b7280', salao: '#2563eb' }

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const setorDe = (c) => (c?.setor === 'cozinha' || c?.setor === 'nenhum' ? c.setor : 'salao')

export default function IfoodSetorCategorias({ empresaId }) {
  const [lojas, setLojas] = useState([])
  const [cats, setCats] = useState([])          // categorias NOSSAS
  const [doIfood, setDoIfood] = useState([])    // categorias DE LÁ, com contagem
  const [vinculos, setVinculos] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [sincronizando, setSincronizando] = useState(false)
  const [msg, setMsg] = useState(null)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setCarregando(true)
    const [{ data: cfgs }, { data: nossas }, { data: itens }, { data: vins }] = await Promise.all([
      supabase.from('ifood_config').select('merchant_id, apelido, principal')
        .eq('empresa_id', empresaId).not('merchant_id', 'is', null)
        .order('principal', { ascending: false }),
      supabase.from('categorias').select('id, nome, setor').eq('empresa_id', empresaId).order('nome'),
      supabase.from('ifood_cardapio_item').select('merchant_id, categoria_id, categoria_nome')
        .eq('empresa_id', empresaId),
      supabase.from('ifood_categoria_vinculo').select('merchant_id, categoria_ifood_id, categoria_id')
        .eq('empresa_id', empresaId),
    ])

    // Agrupa os itens por categoria só pra mostrar "quantos itens tem nela" —
    // é esse número que diz se vale a pena ligar ou se é categoria morta.
    const mapa = new Map()
    for (const it of (itens ?? [])) {
      const chave = it.merchant_id + '|' + it.categoria_id
      const e = mapa.get(chave)
      if (e) e.itens += 1
      else mapa.set(chave, { merchant_id: it.merchant_id, categoria_id: it.categoria_id, nome: it.categoria_nome, itens: 1 })
    }

    setLojas(cfgs ?? [])
    setCats(nossas ?? [])
    setDoIfood([...mapa.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')))
    setVinculos(vins ?? [])
    setCarregando(false)
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])

  // Mesma ordem de decisão do banco, pra tela e papel nunca discordarem:
  // vínculo explícito -> categoria daqui com o mesmo nome -> nada.
  function destinoDe(cat) {
    const v = vinculos.find(x => x.merchant_id === cat.merchant_id && x.categoria_ifood_id === cat.categoria_id)
    if (v) {
      const c = cats.find(x => x.id === v.categoria_id)
      if (c) return { categoria: c, como: 'vinculo' }
    }
    const igual = cats.find(x => norm(x.nome) === norm(cat.nome))
    if (igual) return { categoria: igual, como: 'nome' }
    return null
  }

  async function ligar(cat, categoriaId) {
    setMsg(null)
    if (!categoriaId) {
      const { error } = await supabase.from('ifood_categoria_vinculo').delete()
        .eq('merchant_id', cat.merchant_id).eq('categoria_ifood_id', cat.categoria_id)
      if (error) { setMsg({ tipo: 'erro', texto: error.message }); return }
      setVinculos(v => v.filter(x => !(x.merchant_id === cat.merchant_id && x.categoria_ifood_id === cat.categoria_id)))
      return
    }
    const linha = {
      merchant_id: cat.merchant_id,
      categoria_ifood_id: cat.categoria_id,
      empresa_id: empresaId,
      categoria_id: categoriaId,
      categoria_nome_ifood: cat.nome,
    }
    const { error } = await supabase.from('ifood_categoria_vinculo')
      .upsert(linha, { onConflict: 'merchant_id,categoria_ifood_id' })
    if (error) { setMsg({ tipo: 'erro', texto: error.message }); return }
    setVinculos(v => [...v.filter(x => !(x.merchant_id === cat.merchant_id && x.categoria_ifood_id === cat.categoria_id)), linha])
  }

  async function sincronizar() {
    setSincronizando(true)
    setMsg(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const url = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'}/functions/v1/ifood-integration`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ acao: 'cardapio_sync', empresa_id: empresaId }),
      })
      const d = await res.json()
      if (d.ok) { await carregar(); setMsg({ tipo: 'ok', texto: 'Lista do iFood atualizada.' }) }
      else setMsg({ tipo: 'erro', texto: d.error ?? 'Não consegui ler o cardápio do iFood' })
    } catch (e) {
      setMsg({ tipo: 'erro', texto: String(e?.message ?? e) })
    }
    setSincronizando(false)
  }

  if (!empresaId) return null

  const semLigar = doIfood.filter(c => !destinoDe(c)).length

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Onde cada item do iFood vai sair</h3>
        <button
          type="button" onClick={sincronizar} disabled={sincronizando}
          style={{
            marginLeft: 'auto', padding: '7px 14px', borderRadius: 8, border: 'none',
            background: RED, color: '#fff', fontWeight: 700, fontSize: 13,
            cursor: sincronizando ? 'wait' : 'pointer', opacity: sincronizando ? 0.6 : 1,
          }}
        >
          {sincronizando ? 'Lendo o iFood…' : '↻ Atualizar lista do iFood'}
        </button>
      </div>

      <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
        Vale só pra <strong>impressão</strong>: diz se o item sai na comanda da cozinha, no cupom da
        frente, ou em nenhum dos dois. O produto <strong>não</strong> é criado no seu catálogo.
        Categoria daqui com o <strong>mesmo nome</strong> da de lá já liga sozinha — a lista abaixo é
        pra quando os nomes não batem.
      </p>

      {semLigar > 0 && (
        <p style={{ margin: '10px 0 0', fontSize: 13, color: RED, fontWeight: 600 }}>
          {semLigar} categoria{semLigar > 1 ? 's' : ''} sem destino. O que vier delas sai na
          <strong> cozinha, marcado como não cadastrado</strong> — de propósito: papel sobrando é
          chateação, prato que ninguém preparou é pedido perdido.
        </p>
      )}

      {msg && (
        <p style={{
          margin: '10px 0 0', fontSize: 13, fontWeight: 600,
          color: msg.tipo === 'ok' ? '#16a34a' : RED,
        }}>{msg.texto}</p>
      )}

      {carregando && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Carregando…</p>}

      {!carregando && doIfood.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12 }}>
          Ainda não li o cardápio do iFood. Clique em “Atualizar lista do iFood”.
        </p>
      )}

      {lojas.map(loja => {
        const daLoja = doIfood.filter(c => c.merchant_id === loja.merchant_id)
        if (!daLoja.length) return null
        return (
          <div key={loja.merchant_id} style={{ marginTop: 18 }}>
            {lojas.length > 1 && (
              <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700 }}>
                {loja.apelido || 'Loja do iFood'}{loja.principal ? ' (principal)' : ''}
              </p>
            )}
            <div style={{ display: 'grid', gap: 6 }}>
              {daLoja.map(cat => {
                const destino = destinoDe(cat)
                const setor = destino ? setorDe(destino.categoria) : 'cozinha'
                const v = vinculos.find(x => x.merchant_id === cat.merchant_id && x.categoria_ifood_id === cat.categoria_id)
                return (
                  <div key={cat.categoria_id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    padding: '8px 10px', borderRadius: 8,
                    border: '1px solid var(--border)',
                    background: destino ? 'transparent' : 'rgba(234,29,44,.06)',
                  }}>
                    <span style={{ minWidth: 170, fontSize: 13, fontWeight: 600 }}>{cat.nome}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{cat.itens} {cat.itens === 1 ? 'item' : 'itens'}</span>

                    <select
                      value={v?.categoria_id ?? ''}
                      onChange={e => ligar(cat, e.target.value || null)}
                      style={{
                        marginLeft: 'auto', padding: '6px 8px', borderRadius: 8, fontSize: 13,
                        border: '1px solid var(--border)', background: 'var(--input-bg, transparent)',
                        color: 'var(--text)', maxWidth: 220,
                      }}
                    >
                      <option value="">
                        {destino?.como === 'nome' ? `automático: ${destino.categoria.nome}` : '— escolher categoria —'}
                      </option>
                      {cats.map(c => (
                        <option key={c.id} value={c.id}>{c.nome} ({ROTULO_SETOR[setorDe(c)]})</option>
                      ))}
                    </select>

                    <span style={{
                      minWidth: 118, textAlign: 'right', fontSize: 12, fontWeight: 700,
                      color: destino ? COR_SETOR[setor] : RED,
                    }}>
                      {destino ? ROTULO_SETOR[setor] : 'Cozinha (marcado)'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
