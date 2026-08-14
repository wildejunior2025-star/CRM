import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabaseClient'

// ============================================================================
// Gerência de cardápio no iFood (módulo Catalog v2.0).
// Cria/edita categoria, item (com foto), grupo de complemento e complemento,
// e pausa item/complemento — tudo direto na Merchant API do iFood.
// Feito pra atender o checklist de homologação do Catalog (Cenários 1, 2 e 3).
// ============================================================================
const RED = '#ea1d2c'
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    }))

const FUNC_URL = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'}/functions/v1/ifood-integration`

async function chamar(payload) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(FUNC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token ?? ''}` },
    body: JSON.stringify(payload),
  })
  return res.json()
}

// Lê um File e devolve data-uri base64 (pro upload do iFood).
function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.onerror = reject
    fr.readAsDataURL(file)
  })
}

const inp = { width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', boxSizing: 'border-box', fontSize: 13.5 }
const btn = (bg) => ({ padding: '8px 14px', borderRadius: 8, cursor: 'pointer', border: 'none', background: bg, color: '#fff', fontWeight: 700, fontSize: 13 })
const btnOut = { padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: `1.5px solid ${RED}`, background: 'transparent', color: RED, fontWeight: 700, fontSize: 12.5 }

function grupoVazio() { return { grupoId: uuid(), nome: '', min: 0, max: 1, opcoes: [] } }
function opcaoVazia() { return { opcaoId: uuid(), produtoId: uuid(), nome: '', preco: '', imagePath: null, imgPreview: null, status: 'AVAILABLE' } }
function itemVazio() { return { itemId: uuid(), productId: uuid(), categoriaId: '', nome: '', preco: '', imagePath: null, imgPreview: null, status: 'AVAILABLE', grupos: [] } }

// ---------------------------------------------------------------------------
// Rascunho: o que ainda NÃO foi salvo no iFood fica guardado no navegador, pra
// não perder o item meio montado ao sair da página / dar F5.
// As fotos são guardadas só pelo imagePath (o preview é remontado pela URL do
// iFood) — data-uri em base64 estouraria o localStorage.
// ---------------------------------------------------------------------------
const CHAVE_RASCUNHO = (id) => `ifood_catalogo_rascunho_${id || 'sem-empresa'}`
const CHAVE_CATS = (id) => `ifood_catalogo_cats_${id || 'sem-empresa'}`
const IMG_BASE = 'https://static-images.ifood.com.br/pratos/'
const previewDe = (p) => (!p ? null : (p.startsWith('http') || p.startsWith('data:') ? p : IMG_BASE + p))
const mapOpcoes = (it, fn) => ({ ...it, grupos: (it.grupos ?? []).map(g => ({ ...g, opcoes: (g.opcoes ?? []).map(fn) })) })
const semPreview = (it) => ({ ...mapOpcoes(it, o => ({ ...o, imgPreview: null })), imgPreview: null })
const comPreview = (it) => ({ ...mapOpcoes(it, o => ({ ...o, imgPreview: previewDe(o.imagePath) })), imgPreview: previewDe(it.imagePath) })
const itemEmBranco = (it) => !it || (!it.nome?.trim() && !it.imagePath && (it.grupos ?? []).length === 0 && !it.preco)

function lerJson(chave) {
  try { const raw = localStorage.getItem(chave); return raw ? JSON.parse(raw) : null } catch { return null }
}
function gravarJson(chave, valor) {
  try { valor == null ? localStorage.removeItem(chave) : localStorage.setItem(chave, JSON.stringify(valor)) } catch { /* cota cheia: rascunho é só conforto */ }
}

export default function IfoodCatalogoManager({ empresaId, merchantOk }) {
  const [categorias, setCategorias] = useState(() => lerJson(CHAVE_CATS(empresaId)))
  const [novaCat, setNovaCat] = useState('')
  const [item, setItem] = useState(() => { const r = lerJson(CHAVE_RASCUNHO(empresaId)); return r ? comPreview(r) : itemVazio() })
  const [salvos, setSalvos] = useState([])             // itens já mandados (pra pausar/editar)
  const [busy, setBusy] = useState('')                 // rótulo da ação em curso
  const [msg, setMsg] = useState(null)                 // { tipo, texto }

  const notify = (tipo, texto) => setMsg({ tipo, texto })

  // Empresa chegou depois (ou o lojista trocou de loja): recarrega o rascunho dela.
  useEffect(() => {
    const r = lerJson(CHAVE_RASCUNHO(empresaId))
    setItem(r ? comPreview(r) : itemVazio())
    setCategorias(lerJson(CHAVE_CATS(empresaId)))
    setSalvos([])
  }, [empresaId])

  // Guarda o rascunho a cada tecla — sair da página não perde mais o item.
  useEffect(() => {
    gravarJson(CHAVE_RASCUNHO(empresaId), itemEmBranco(item) ? null : semPreview(item))
  }, [item, empresaId])

  // Guarda as categorias já carregadas, pra caixinha não voltar vazia no F5.
  useEffect(() => { gravarJson(CHAVE_CATS(empresaId), categorias) }, [categorias, empresaId])

  async function carregarCategorias() {
    setBusy('cats'); setMsg(null)
    const d = await chamar({ acao: 'catalogo_categorias', empresa_id: empresaId })
    if (d.ok) setCategorias(d.categorias ?? [])
    else notify('erro', d.error ?? 'Falha ao listar categorias')
    setBusy('')
  }

  async function criarCategoria() {
    if (!novaCat.trim()) return
    setBusy('novaCat'); setMsg(null)
    const d = await chamar({ acao: 'catalogo_criar_categoria', empresa_id: empresaId, nome: novaCat.trim() })
    if (d.ok) {
      notify('ok', `Categoria "${d.nome}" criada no iFood.`)
      setNovaCat('')
      setCategorias(prev => ([...(prev ?? []), { id: d.id, nome: d.nome, status: 'AVAILABLE' }]))
      setItem(it => ({ ...it, categoriaId: it.categoriaId || d.id }))
    } else notify('erro', d.error ?? 'Falha ao criar categoria')
    setBusy('')
  }

  // Sobe a foto e guarda o imagePath no alvo (item ou opção).
  async function subirFoto(file, aplicar) {
    if (!file) return
    setBusy('foto'); setMsg(null)
    try {
      const dataUri = await fileToDataUri(file)
      const d = await chamar({ acao: 'catalogo_upload_imagem', empresa_id: empresaId, image: dataUri })
      if (d.ok) aplicar(d.imagePath, dataUri)
      else notify('erro', d.error ?? 'Falha no upload da foto')
    } catch (e) { notify('erro', String(e.message ?? e)) }
    setBusy('')
  }

  function addGrupo() { setItem(it => ({ ...it, grupos: [...it.grupos, grupoVazio()] })) }
  function setGrupo(gid, patch) { setItem(it => ({ ...it, grupos: it.grupos.map(g => g.grupoId === gid ? { ...g, ...patch } : g) })) }
  function delGrupo(gid) { setItem(it => ({ ...it, grupos: it.grupos.filter(g => g.grupoId !== gid) })) }
  function addOpcao(gid) { setItem(it => ({ ...it, grupos: it.grupos.map(g => g.grupoId === gid ? { ...g, opcoes: [...g.opcoes, opcaoVazia()] } : g) })) }
  function setOpcao(gid, oid, patch) {
    setItem(it => ({ ...it, grupos: it.grupos.map(g => g.grupoId === gid ? { ...g, opcoes: g.opcoes.map(o => o.opcaoId === oid ? { ...o, ...patch } : o) } : g) }))
  }
  function delOpcao(gid, oid) { setItem(it => ({ ...it, grupos: it.grupos.map(g => g.grupoId === gid ? { ...g, opcoes: g.opcoes.filter(o => o.opcaoId !== oid) } : g) })) }

  async function salvarItem() {
    if (!item.categoriaId) return notify('erro', 'Escolha a categoria do item.')
    if (!item.nome.trim()) return notify('erro', 'Dê um nome ao item.')
    setBusy('salvarItem'); setMsg(null)
    const payload = {
      itemId: item.itemId, productId: item.productId, categoriaId: item.categoriaId,
      nome: item.nome.trim(), preco: Number(item.preco || 0), imagePath: item.imagePath, status: item.status,
      grupos: item.grupos.map(g => ({
        grupoId: g.grupoId, nome: g.nome.trim() || 'Complementos', min: Number(g.min || 0), max: Number(g.max || 1),
        opcoes: g.opcoes.map(o => ({ opcaoId: o.opcaoId, produtoId: o.produtoId, nome: o.nome.trim() || 'Opção', preco: Number(o.preco || 0), imagePath: o.imagePath, status: o.status })),
      })),
    }
    const d = await chamar({ acao: 'catalogo_salvar_item', empresa_id: empresaId, payload })
    if (d.ok) {
      notify('ok', `Item "${item.nome}" salvo no iFood.`)
      setSalvos(prev => { const outros = prev.filter(x => x.itemId !== item.itemId); return [{ ...item, salvo: true }, ...outros] })
    } else notify('erro', d.error ?? 'Falha ao salvar o item')
    setBusy('')
  }

  // Puxa os itens que JÁ estão no iFood (completos, com complementos) pra lista de
  // baixo — aí dá pra clicar "Editar" e alterar sem recriar nada.
  async function verItensIfood() {
    setBusy('verItens'); setMsg(null)
    const d = await chamar({ acao: 'catalogo_itens', empresa_id: empresaId })
    if (d.ok) {
      const itens = (d.itens ?? []).map(it => ({
        ...it, salvo: true, imgPreview: it.imagemUrl || null,
        grupos: (it.grupos ?? []).map(g => ({ ...g, opcoes: (g.opcoes ?? []).map(o => ({ ...o, imgPreview: o.imagemUrl || null })) })),
      }))
      setSalvos(itens)
      if (itens.length === 0) notify('ok', 'Nenhum item no iFood ainda — crie um acima.')
    } else notify('erro', d.error ?? 'Falha ao listar itens do iFood')
    setBusy('')
  }

  function editar(it) {
    setItem({ ...it })
    // Garante que a categoria do item apareça selecionada na caixinha (mesmo sem
    // ter clicado em "Carregar categorias" antes).
    if (it.categoriaId) {
      setCategorias(prev => {
        const arr = prev ?? []
        return arr.some(c => c.id === it.categoriaId) ? arr : [...arr, { id: it.categoriaId, nome: it.categoriaNome || 'categoria', status: 'AVAILABLE' }]
      })
    }
    setMsg({ tipo: 'ok', texto: `Item "${it.nome}" carregado no formulário — altere e clique em "Salvar no iFood".` })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function novo() { setItem(itemVazio()); gravarJson(CHAVE_RASCUNHO(empresaId), null); setMsg(null) }

  async function pausarItem(it, pausar) {
    setBusy('pausa-' + it.itemId)
    const d = await chamar({ acao: 'catalogo_pausar', empresa_id: empresaId, item_id: it.itemId, pausar })
    if (d.ok) setSalvos(prev => prev.map(x => x.itemId === it.itemId ? { ...x, status: pausar ? 'UNAVAILABLE' : 'AVAILABLE' } : x))
    else notify('erro', d.error ?? 'Falha ao pausar o item')
    setBusy('')
  }

  async function pausarComplemento(it, opcaoId, pausar) {
    setBusy('pausaC-' + opcaoId)
    const d = await chamar({ acao: 'catalogo_pausar_complemento', empresa_id: empresaId, option_id: opcaoId, pausar })
    if (d.ok) {
      setSalvos(prev => prev.map(x => x.itemId !== it.itemId ? x : {
        ...x, grupos: x.grupos.map(g => ({ ...g, opcoes: g.opcoes.map(o => o.opcaoId === opcaoId ? { ...o, status: pausar ? 'UNAVAILABLE' : 'AVAILABLE' } : o) })),
      }))
    } else notify('erro', d.error ?? 'Falha ao pausar o complemento')
    setBusy('')
  }

  if (!merchantOk) return null

  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: 12, paddingTop: 12 }}>
      <strong style={{ fontSize: 14 }}>Gerenciar cardápio no iFood</strong>
      <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '2px 0 10px' }}>
        Cria e edita categoria, item, foto e complemento direto no iFood. (Módulo Catalog — em homologação.)
      </p>

      {msg && (
        <div style={{ margin: '0 0 10px', padding: '8px 10px', borderRadius: 8, fontSize: 12.5,
          background: msg.tipo === 'ok' ? 'rgba(22,163,74,.12)' : 'rgba(220,38,38,.12)', color: msg.tipo === 'ok' ? '#16a34a' : '#dc2626' }}>
          {msg.texto}
        </div>
      )}

      {/* 1) Categoria */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <input style={{ ...inp, flex: 1, minWidth: 160 }} placeholder='Nova categoria (ex.: Teste Homologação)' value={novaCat} onChange={e => setNovaCat(e.target.value)} />
        <button type="button" style={btn(RED)} disabled={busy === 'novaCat' || !novaCat.trim()} onClick={criarCategoria}>
          {busy === 'novaCat' ? '...' : '+ Criar categoria'}
        </button>
        <button type="button" style={btnOut} disabled={busy === 'cats'} onClick={carregarCategorias}>
          {busy === 'cats' ? '...' : (categorias ? '🔄 Categorias' : 'Carregar categorias')}
        </button>
      </div>

      {/* 2) Item */}
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>Item</strong>
          <button type="button" style={{ ...btnOut, border: '1.5px solid var(--border)', color: 'var(--text-muted)' }} onClick={novo}>Limpar / novo item</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>
          O que você digita aqui fica guardado neste navegador — pode sair da página ou atualizar que o item volta do jeito que estava. Só some com "Limpar / novo item".
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8, marginBottom: 8 }}>
          <input style={inp} placeholder='Nome do item (ex.: Produto Teste)' value={item.nome} onChange={e => setItem(it => ({ ...it, nome: e.target.value }))} />
          <input style={inp} placeholder='Preço' inputMode='decimal' value={item.preco} onChange={e => setItem(it => ({ ...it, preco: e.target.value }))} />
        </div>
        <select style={{ ...inp, marginBottom: 8 }} value={item.categoriaId} onChange={e => setItem(it => ({ ...it, categoriaId: e.target.value }))}>
          <option value=''>Selecione a categoria…</option>
          {(categorias ?? []).map(c => <option key={c.id} value={c.id}>{c.nome}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
          {item.imgPreview && <img src={item.imgPreview} alt='' style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover' }} />}
          <label style={{ ...btnOut, display: 'inline-block' }}>
            {item.imagePath ? '🖼 Trocar foto' : '📷 Adicionar foto'}
            <input type='file' accept='image/*' style={{ display: 'none' }}
              onChange={e => subirFoto(e.target.files?.[0], (path, prev) => setItem(it => ({ ...it, imagePath: path, imgPreview: prev })))} />
          </label>
          {busy === 'foto' && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>enviando foto…</span>}
        </div>

        {/* Grupos de complemento */}
        {item.grupos.map(g => (
          <div key={g.grupoId} style={{ border: '1px dashed var(--border)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px auto', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <input style={inp} placeholder='Nome do grupo (ex.: Adicionais)' value={g.nome} onChange={e => setGrupo(g.grupoId, { nome: e.target.value })} />
              <input style={inp} placeholder='mín' inputMode='numeric' value={g.min} onChange={e => setGrupo(g.grupoId, { min: e.target.value })} title='Mínimo' />
              <input style={inp} placeholder='máx' inputMode='numeric' value={g.max} onChange={e => setGrupo(g.grupoId, { max: e.target.value })} title='Máximo' />
              <button type="button" style={{ ...btnOut, border: '1.5px solid var(--border)', color: '#dc2626' }} onClick={() => delGrupo(g.grupoId)}>✕</button>
            </div>
            {g.opcoes.map(o => (
              <div key={o.opcaoId} style={{ display: 'grid', gridTemplateColumns: '1fr 80px auto auto', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <input style={inp} placeholder='Complemento (ex.: Bacon)' value={o.nome} onChange={e => setOpcao(g.grupoId, o.opcaoId, { nome: e.target.value })} />
                <input style={inp} placeholder='Preço' inputMode='decimal' value={o.preco} onChange={e => setOpcao(g.grupoId, o.opcaoId, { preco: e.target.value })} />
                <label style={{ ...btnOut, padding: '6px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {o.imgPreview ? <img src={o.imgPreview} alt='' style={{ width: 20, height: 20, borderRadius: 4, objectFit: 'cover' }} /> : '📷'}
                  <input type='file' accept='image/*' style={{ display: 'none' }}
                    onChange={e => subirFoto(e.target.files?.[0], (path, prev) => setOpcao(g.grupoId, o.opcaoId, { imagePath: path, imgPreview: prev }))} />
                </label>
                <button type="button" style={{ ...btnOut, border: '1.5px solid var(--border)', color: '#dc2626' }} onClick={() => delOpcao(g.grupoId, o.opcaoId)}>✕</button>
              </div>
            ))}
            <button type="button" style={{ ...btnOut, fontSize: 12 }} onClick={() => addOpcao(g.grupoId)}>+ complemento</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <button type="button" style={btnOut} onClick={addGrupo}>+ grupo de complemento</button>
          <button type="button" style={{ ...btn(RED), marginLeft: 'auto' }} disabled={busy === 'salvarItem'} onClick={salvarItem}>
            {busy === 'salvarItem' ? 'Salvando…' : '💾 Salvar no iFood'}
          </button>
        </div>
      </div>

      {/* 3) Itens que já estão no iFood — editar / pausar item e complemento */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <strong style={{ fontSize: 13 }}>Itens no iFood</strong>
          <button type="button" style={btnOut} disabled={busy === 'verItens'} onClick={verItensIfood}>
            {busy === 'verItens' ? 'Carregando…' : '🔄 Ver itens do iFood'}
          </button>
        </div>
        {salvos.length === 0 && (
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: 0 }}>
            Clique em <strong>“Ver itens do iFood”</strong> pra carregar os itens já cadastrados — aí é só clicar em <strong>Editar</strong> pra alterar.
          </p>
        )}
        {salvos.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {salvos.map(it => {
              const pausado = it.status === 'UNAVAILABLE'
              return (
                <div key={it.itemId} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                      {it.imgPreview && <img src={it.imgPreview} alt='' style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover', verticalAlign: 'middle', marginRight: 6 }} />}
                      {it.nome}{it.preco ? ` · R$ ${Number(it.preco).toFixed(2)}` : ''}{pausado ? ' · ⏸' : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" style={btnOut} onClick={() => editar(it)}>✏ Editar</button>
                      <button type="button" style={{ ...btnOut, border: `1.5px solid ${pausado ? '#16a34a' : '#f59e0b'}`, color: pausado ? '#16a34a' : '#b45309' }}
                        disabled={busy === 'pausa-' + it.itemId} onClick={() => pausarItem(it, !pausado)}>
                        {busy === 'pausa-' + it.itemId ? '...' : (pausado ? '▶ Despausar' : '⏸ Pausar')}
                      </button>
                    </div>
                  </div>
                  {it.grupos.flatMap(g => g.opcoes).length > 0 && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)', display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {it.grupos.flatMap(g => g.opcoes).map(o => {
                        const op = o.status === 'UNAVAILABLE'
                        return (
                          <div key={o.opcaoId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
                            <span style={{ color: 'var(--text-muted)' }}>↳ {o.nome}{o.preco ? ` · R$ ${Number(o.preco).toFixed(2)}` : ''}{op ? ' · ⏸' : ''}</span>
                            <button type="button" style={{ ...btnOut, padding: '4px 10px', border: `1.5px solid ${op ? '#16a34a' : '#f59e0b'}`, color: op ? '#16a34a' : '#b45309' }}
                              disabled={busy === 'pausaC-' + o.opcaoId} onClick={() => pausarComplemento(it, o.opcaoId, !op)}>
                              {busy === 'pausaC-' + o.opcaoId ? '...' : (op ? '▶ Despausar' : '⏸ Pausar')}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
