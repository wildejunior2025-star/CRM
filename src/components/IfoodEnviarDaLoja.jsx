import { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import './IfoodCatalogo.css'

// ============================================================================
// Manda produtos do catálogo DAQUI pro iFood — o contrário do "Importar".
//
// O preço vai com um acréscimo em % escolhido pelo lojista: no iFood saem ~12%
// de comissão + ~4% da transação, então publicar o preço do balcão seria tirar
// essa diferença da própria margem. A tela mostra o de-para item por item antes
// de confirmar, porque depois de publicado o preço errado já está no ar.
// ============================================================================
const RED = '#ea1d2c'
const LIMITE = 25   // igual ao teto da edge function (cada item é upload + PUT)

const inp = { padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', boxSizing: 'border-box', fontSize: 13.5 }
const reais = (v) => Number(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function IfoodEnviarDaLoja({ empresaId, onPronto }) {
  const [aberto, setAberto] = useState(false)
  const [produtos, setProdutos] = useState(null)     // todos os ativos da loja
  const [categoria, setCategoria] = useState('')     // categoria DAQUI
  const [pct, setPct] = useState('20')
  const [marcados, setMarcados] = useState(() => new Set())
  const [catsIfood, setCatsIfood] = useState([])
  const [destino, setDestino] = useState('nova')     // 'nova' | id de categoria do iFood
  const [nomeNova, setNomeNova] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    if (!aberto || !empresaId || produtos) return
    // fetchAll pagina: acima de 1000 produtos o PostgREST corta calado, e a
    // categoria apareceria pela metade sem ninguém notar.
    fetchAll(() =>
      supabase.from('produtos')
        .select('id, nome, categoria, preco_venda, foto_url')
        .eq('empresa_id', empresaId)
        .eq('ativo', true)
        .order('categoria')
        .order('nome')
    ).then(({ data }) => setProdutos(data ?? []))

    chamar({ acao: 'catalogo_categorias', empresa_id: empresaId })
      .then(d => { if (d.ok) setCatsIfood(d.categorias ?? []) })
  }, [aberto, empresaId, produtos])

  const categorias = useMemo(() => {
    const nomes = new Set((produtos ?? []).map(p => p.categoria).filter(Boolean))
    return [...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  }, [produtos])

  const daCategoria = useMemo(
    () => (produtos ?? []).filter(p => p.categoria === categoria),
    [produtos, categoria],
  )

  // Trocar de categoria marca tudo dela — o caso comum é mandar a categoria
  // inteira; desmarcar exceção é mais raro que marcar um por um.
  function escolherCategoria(nome) {
    setCategoria(nome)
    setNomeNova(nome)
    setDestino('nova')
    setMarcados(new Set((produtos ?? []).filter(p => p.categoria === nome).map(p => p.id)))
    setMsg(null)
  }

  const pctNum = Math.max(0, Number(String(pct).replace(',', '.')) || 0)
  const comAcrescimo = (v) => Math.round(Number(v ?? 0) * (1 + pctNum / 100) * 100) / 100
  const selecionados = daCategoria.filter(p => marcados.has(p.id))
  const passouDoLimite = selecionados.length > LIMITE

  async function enviar() {
    setEnviando(true); setMsg(null)
    const d = await chamar({
      acao: 'catalogo_enviar_loja',
      empresa_id: empresaId,
      produto_ids: selecionados.map(p => p.id),
      acrescimo_pct: pctNum,
      ...(destino === 'nova' ? { categoria_nome: nomeNova.trim() || categoria } : { categoria_ifood_id: destino }),
    })
    if (d.ok) {
      setMsg({
        tipo: d.avisos?.length ? 'aviso' : 'ok',
        texto: `${d.enviados} de ${d.total} item(ns) publicado(s) no iFood.`,
        avisos: d.avisos ?? [],
      })
      setMarcados(new Set())
      onPronto?.()
    } else setMsg({ tipo: 'erro', texto: d.error ?? 'Falha ao enviar' })
    setEnviando(false)
  }

  if (!aberto) {
    return (
      <button type="button" className="ifc-acao" style={{ ...botao, marginBottom: 12 }} onClick={() => setAberto(true)}>
        ⬆ Enviar da minha loja pro iFood
      </button>
    )
  }

  return (
    <div style={{ border: `1.5px solid ${RED}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <strong style={{ fontSize: 14 }}>Enviar da minha loja pro iFood</strong>
        <button type="button" onClick={() => setAberto(false)}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18 }}>✕</button>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Publica no iFood os produtos que já estão cadastrados aqui, com foto e descrição.
        Não mexe no seu cardápio da loja.
      </p>

      {!produtos && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Carregando seus produtos…</p>}

      {produtos && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
            <label style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
              Categoria daqui
              <select style={{ ...inp, minWidth: 200 }} value={categoria} onChange={e => escolherCategoria(e.target.value)}>
                <option value=''>Escolha…</option>
                {categorias.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
              Acréscimo no preço
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input style={{ ...inp, width: 70 }} inputMode='decimal' value={pct} onChange={e => setPct(e.target.value)} />
                <span style={{ fontSize: 13 }}>%</span>
              </span>
            </label>
            {categoria && (
              <label style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
                Vai pra qual categoria do iFood
                <select style={{ ...inp, minWidth: 210 }} value={destino} onChange={e => setDestino(e.target.value)}>
                  <option value='nova'>Criar categoria nova</option>
                  {catsIfood.map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
                </select>
              </label>
            )}
            {categoria && destino === 'nova' && (
              <label style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
                Nome da categoria nova
                <input style={{ ...inp, minWidth: 190 }} value={nomeNova} onChange={e => setNomeNova(e.target.value)} />
              </label>
            )}
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 10px' }}>
            No iFood saem ~12% de comissão + ~4% da transação. Sem acréscimo, essa diferença sai da sua margem.
          </p>

          {categoria && daCategoria.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum produto ativo nessa categoria.</p>
          )}

          {daCategoria.length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6, fontSize: 12.5 }}>
                <button type="button" onClick={() => setMarcados(new Set(daCategoria.map(p => p.id)))}
                  style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: RED, fontWeight: 700 }}>marcar todos</button>
                <button type="button" onClick={() => setMarcados(new Set())}
                  style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-muted)', fontWeight: 700 }}>limpar</button>
                <span style={{ color: 'var(--text-muted)' }}>{selecionados.length} de {daCategoria.length} marcado(s)</span>
              </div>

              <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                {daCategoria.map(p => {
                  const marcado = marcados.has(p.id)
                  return (
                    <label key={p.id} className="ifc-opcao" style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                      borderBottom: '1px solid var(--border)', cursor: 'pointer',
                    }}>
                      <input type='checkbox' checked={marcado} style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
                        onChange={() => setMarcados(prev => {
                          const s = new Set(prev)
                          marcado ? s.delete(p.id) : s.add(p.id)
                          return s
                        })} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.nome}
                        {!p.foto_url && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> · sem foto</span>}
                      </span>
                      <span style={{ flexShrink: 0, color: 'var(--text-muted)' }}>R$ {reais(p.preco_venda)}</span>
                      <span style={{ flexShrink: 0, color: RED, fontWeight: 700 }}>→ R$ {reais(comAcrescimo(p.preco_venda))}</span>
                    </label>
                  )
                })}
              </div>
            </>
          )}

          {passouDoLimite && (
            <p style={{ fontSize: 12.5, color: '#b45309', marginTop: 10, marginBottom: 0 }}>
              Máximo de {LIMITE} por vez (cada item sobe foto e publica). Desmarque alguns e mande o resto numa segunda leva.
            </p>
          )}

          {msg && (
            <div style={{
              marginTop: 12, padding: '10px 12px', borderRadius: 8, fontSize: 12.5,
              background: msg.tipo === 'erro' ? 'rgba(220,38,38,.12)' : msg.tipo === 'aviso' ? 'rgba(245,158,11,.12)' : 'rgba(22,163,74,.12)',
              color: msg.tipo === 'erro' ? '#dc2626' : msg.tipo === 'aviso' ? '#b45309' : '#16a34a',
            }}>
              {msg.texto}
              {msg.avisos?.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {msg.avisos.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              )}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <button type="button" className="ifc-acao" style={{ ...botao, opacity: (selecionados.length && !passouDoLimite) ? 1 : .5 }}
              disabled={enviando || selecionados.length === 0 || passouDoLimite}
              onClick={enviar}>
              {enviando ? 'Publicando no iFood…' : `Publicar ${selecionados.length || ''} item${selecionados.length === 1 ? '' : 'ns'} no iFood`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

const botao = { borderRadius: 8, cursor: 'pointer', border: 'none', background: RED, color: '#fff', fontWeight: 700 }

async function chamar(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const url = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'}/functions/v1/ifood-integration`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token ?? ''}` },
    body: JSON.stringify(payload),
  })
  return res.json()
}
