import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import BuscaSelect from './BuscaSelect'

// Botão "Lançar nota (IA)": tira foto/PDF da nota de compra, a IA lê e casa cada item
// com PRODUTO (revenda) ou MATÉRIA-PRIMA (insumo), dando entrada no estoque certo.
// Reaproveitado no Estoque e na Ficha Técnica (a nota do mercado vem misturada).
export default function LancarNotaIA({ empresaId, onDone }) {
  const [show, setShow] = useState(false)
  const [step, setStep] = useState('upload') // 'upload' | 'lendo' | 'revisar'
  const [produtos, setProdutos] = useState([])
  const [materias, setMaterias] = useState([])
  // Uma lista só. Cada linha da nota aponta pra um DESTINO, que a loja pode
  // trocar: 'prod:<id>' (produto de revenda), 'mat:<id>' (insumo) ou 'novo'
  // (cadastra na hora). A IA chuta o destino; quem manda é quem confere.
  // [{ descricao, destino, nomeNovo, unidadeNovo, quantidade, custo_unit, incluir }]
  const [itens, setItens] = useState([])
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [atualizarCusto, setAtualizarCusto] = useState(true)
  const [salvando, setSalvando] = useState(false)

  async function abrir() {
    setStep('upload'); setItens([]); setErro(null); setAviso(null); setAtualizarCusto(true); setShow(true)
    const [pr, mp] = await Promise.all([
      supabase.from('produtos').select('id, nome').eq('empresa_id', empresaId).eq('ativo', true).order('nome'),
      supabase.from('materias_primas').select('id, nome, unidade').eq('empresa_id', empresaId).eq('ativo', true).order('nome'),
    ])
    setProdutos(pr.data || [])
    setMaterias(mp.data || [])
  }

  async function lerArquivo(file) {
    if (!file) return
    const ehPdf = file.type === 'application/pdf'
    setErro(null); setStep('lendo')
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result).split(',')[1] || '')
        r.onerror = rej
        r.readAsDataURL(file)
      })
      const { data, error } = await supabase.functions.invoke('ler-nota-estoque', {
        body: {
          imageBase64: base64,
          mimetype: file.type || (ehPdf ? 'application/pdf' : 'image/png'),
          produtos: produtos.map(p => ({ id: p.id, nome: p.nome })),
          materias: materias.map(m => ({ id: m.id, nome: m.nome })),
        },
      })
      // Em erro, o supabase-js devolve só "non-2xx status code" e esconde o motivo no
      // corpo da resposta — abre pra mostrar o recado de verdade pro lojista.
      if (error) {
        let msg = error.message
        try {
          const corpo = await error.context?.json?.()
          if (corpo?.error) msg = corpo.error
        } catch { /* sem corpo legível, fica a mensagem genérica */ }
        throw new Error(msg)
      }
      if (!data?.ok) throw new Error(data?.error || 'Não consegui ler a nota.')
      setAviso(data.aviso || null)
      const din = (v) => (v != null ? String(v).replace('.', ',') : '')
      setItens([
        // O que a IA conseguiu casar com o cadastro.
        ...(data.itens || []).map(it => ({
          descricao: it.descricao || it.nome || '',
          destino: (it.tipo === 'produto' ? 'prod:' : 'mat:') + it.id,
          nomeNovo: it.descricao || it.nome || '',
          unidadeNovo: 'un',
          quantidade: String(it.quantidade),
          custo_unit: din(it.custo_unit),
          incluir: true,
        })),
        // O que ela não achou já vem no modo "criar na hora" — mas dá pra apontar
        // pra um item existente, que é o caso do nome abreviado na nota.
        ...(data.nao_encontrados || []).map(n => ({
          descricao: n.descricao || n.nome || '',
          destino: 'novo',
          nomeNovo: n.nome || '',
          unidadeNovo: n.unidade || 'un',
          quantidade: String(n.quantidade ?? ''),
          custo_unit: din(n.custo_unit),
          incluir: true,
        })),
      ])
      setStep('revisar')
    } catch (e) {
      setErro(e.message || 'Falha ao ler a nota.')
      setStep('upload')
    }
  }

  // Colar (Ctrl+V) a foto da nota enquanto o modal está no passo de upload.
  useEffect(() => {
    if (!show || step !== 'upload') return
    function onPaste(e) {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type?.startsWith('image/'))
      if (!item) return
      const file = item.getAsFile()
      if (file) { e.preventDefault(); lerArquivo(file) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, step, produtos, materias])

  const setItem = (idx, patch) => setItens(arr => arr.map((x, i) => i === idx ? { ...x, ...patch } : x))
  const num = (v) => Number(String(v).replace(',', '.'))
  const normTxt = (s) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()

  // O que dá pra escolher em cada linha: qualquer produto, qualquer insumo, ou
  // cadastrar um insumo novo com o nome que a loja escrever.
  const opcoesDestino = useMemo(() => [
    { key: 'novo', label: '➕ Cadastrar como insumo novo', tag: 'Novo' },
    ...produtos.map(p => ({ key: 'prod:' + p.id, label: p.nome, tag: 'Produto' })),
    ...materias.map(m => ({ key: 'mat:' + m.id, label: m.nome, sub: m.unidade, tag: 'Insumo' })),
  ], [produtos, materias])

  const unidadeDe = (l) => {
    if (l.destino === 'novo') return l.unidadeNovo
    if (l.destino?.startsWith('mat:')) return materias.find(m => 'mat:' + m.id === l.destino)?.unidade || ''
    return 'un'
  }

  // Cria os insumos marcados como "novo". Se já existir um com o mesmo nome,
  // reusa em vez de criar repetido — senão o estoque nasce dividido em dois.
  async function resolverNovos(incluidas) {
    const mapa = new Map()   // índice da linha -> id do insumo criado/achado
    for (const { l, i } of incluidas) {
      if (l.destino !== 'novo') continue
      const nome = (l.nomeNovo || '').trim()
      if (!nome) throw new Error('Uma linha ficou sem nome pra cadastrar.')
      const custo = num(l.custo_unit)
      const jaTem = materias.find(m => normTxt(m.nome) === normTxt(nome))
      if (jaTem) {
        if (atualizarCusto && custo > 0) await supabase.from('materias_primas').update({ custo }).eq('id', jaTem.id)
        mapa.set(i, jaTem.id)
        continue
      }
      const { data, error } = await supabase.from('materias_primas')
        .insert({ empresa_id: empresaId, nome, unidade: l.unidadeNovo || 'un', custo: custo > 0 ? custo : 0 })
        .select('id').single()
      if (error) throw new Error(`Não deu pra criar "${nome}": ${error.message}`)
      mapa.set(i, data.id)
    }
    return mapa
  }

  async function confirmar() {
    const incluidas = itens.map((l, i) => ({ l, i })).filter(({ l }) => l.incluir && num(l.quantidade) > 0)
    if (!incluidas.length) { setErro('Marque ao menos um item pra lançar.'); return }
    const semDestino = incluidas.find(({ l }) => !l.destino || (l.destino === 'novo' && !(l.nomeNovo || '').trim()))
    if (semDestino) { setErro('Tem linha sem destino escolhido. Aponte pra um item ou dê um nome pro novo.'); return }
    setSalvando(true); setErro(null)
    // O preço da nota vai junto NA LINHA da entrada — é o que sustenta o
    // histórico de compras (quanto gastei no dia / o insumo subiu?).
    const precoDe = (l) => { const c = num(l.custo_unit); return Number.isFinite(c) && c > 0 ? c : null }
    try {
      const novos = await resolverNovos(incluidas)
      const prodLinhas = [], matLinhas = []
      for (const { l, i } of incluidas) {
        const qtd = num(l.quantidade)
        const unit = precoDe(l)
        const valor = unit ? unit * qtd : null
        if (l.destino.startsWith('prod:')) {
          prodLinhas.push({
            produto_id: l.destino.slice(5), tipo: 'entrada', quantidade: qtd,
            motivo: 'compra', observacao: 'Nota de compra (IA)',
            custo_unit: unit, valor_total: valor,
          })
        } else {
          const id = l.destino === 'novo' ? novos.get(i) : l.destino.slice(4)
          matLinhas.push({
            empresa_id: empresaId, materia_prima_id: id, tipo: 'entrada', quantidade: qtd,
            custo_unit: unit, valor_total: valor, observacao: 'Nota de compra (IA)',
          })
        }
      }
      if (prodLinhas.length) { const { error } = await supabase.from('estoque_movimentos').insert(prodLinhas); if (error) throw error }
      if (matLinhas.length) { const { error } = await supabase.from('materia_prima_movimentos').insert(matLinhas); if (error) throw error }
      // Atualiza o custo do cadastro de quem JÁ existia (o novo já nasceu com ele).
      if (atualizarCusto) {
        for (const { l } of incluidas) {
          const custo = precoDe(l)
          if (!custo) continue
          if (l.destino.startsWith('prod:')) await supabase.from('produtos').update({ preco_custo: custo }).eq('id', l.destino.slice(5))
          else if (l.destino.startsWith('mat:')) await supabase.from('materias_primas').update({ custo }).eq('id', l.destino.slice(4))
        }
      }
    } catch (e) {
      setSalvando(false); setErro('Erro ao lançar: ' + e.message); return
    }
    setSalvando(false); setShow(false)
    if (onDone) onDone()
  }

  const marcadas = itens.filter(l => l.incluir && num(l.quantidade) > 0)
  const nProd = marcadas.filter(l => l.destino?.startsWith('prod:')).length
  const nMat = marcadas.filter(l => l.destino?.startsWith('mat:')).length
  const nNovo = marcadas.filter(l => l.destino === 'novo').length

  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={abrir}
        title="Tira foto/PDF da nota de compra e a IA lança as entradas (produtos e matérias-primas)">
        📄 Lançar nota (IA)
      </button>

      {show && (
        <div className="modal-overlay" onClick={() => setShow(false)} style={{ zIndex: 1100 }}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
            <h2>📄 Lançar nota de compra (IA)</h2>
            {erro && <p className="error-text">{erro}</p>}

            {step === 'upload' && (
              <>
                <p style={{ fontSize: 13.5, color: 'var(--text-muted)' }}>
                  Tire foto da nota (ou PDF). A IA separa sozinha o que é <strong>produto de revenda</strong> e o que é
                  <strong> matéria-prima</strong>, e dá entrada no estoque certo. Você confere antes de salvar.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                  <label className="btn btn-primary" style={{ cursor: 'pointer', textAlign: 'center' }}>
                    📷 Escolher foto ou PDF do PC
                    <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }}
                      onChange={e => { const f = e.target.files?.[0]; if (f) lerArquivo(f) }} />
                  </label>
                  <div style={{ padding: '18px', border: '1.5px dashed var(--border)', borderRadius: 10, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5 }}>
                    …ou aperte <strong>Ctrl+V</strong> pra colar a foto da nota (print/foto copiada).
                  </div>
                </div>
              </>
            )}

            {step === 'lendo' && (
              <div style={{ padding: '28px 0', textAlign: 'center' }}>
                <div style={{ fontSize: 30, marginBottom: 8 }}>🤖</div>
                <div style={{ fontWeight: 700 }}>Lendo a nota…</div>
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Pode levar alguns segundos.</div>
              </div>
            )}

            {step === 'revisar' && (
              <>
                <p style={{ fontSize: 13.5, color: 'var(--text-muted)' }}>
                  Em cima de cada linha está o que veio <strong>escrito na nota</strong>. Se a IA mandou pro item
                  errado, troque no campo <strong>"Lançar em"</strong> — dá pra apontar pra qualquer produto ou insumo
                  que você já tem, ou cadastrar um novo na hora. Só entra o que estiver marcado.
                </p>
                {aviso && (
                  <div style={{
                    margin: '8px 0', padding: '8px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                    background: 'rgba(217,119,6,.12)', color: '#b45309', border: '1px solid rgba(217,119,6,.4)',
                  }}>⚠️ {aviso}</div>
                )}
                {itens.length === 0 ? (
                  <div className="empty-state">Não consegui achar nenhum item nessa nota.</div>
                ) : (
                  <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                    {itens.map((l, idx) => (
                      <div key={idx} style={{
                        border: '1px solid var(--border)', borderRadius: 10, padding: '9px 11px',
                        opacity: l.incluir ? 1 : .5,
                        background: l.destino === 'novo' ? 'rgba(217,119,6,.07)' : 'transparent',
                      }}>
                        {/* O que veio ESCRITO na nota, abreviação e tudo. É por aqui
                            que a loja confere se a IA casou com o item certo. */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <input type="checkbox" checked={l.incluir} style={{ width: 'auto' }}
                            onChange={e => setItem(idx, { incluir: e.target.checked })} />
                          <span style={{ fontSize: 13, fontWeight: 700, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            📄 {l.descricao || '(sem descrição na nota)'}
                          </span>
                        </div>

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                          <div style={{ flex: '2 1 220px', minWidth: 0 }}>
                            <label style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>Lançar em</label>
                            <BuscaSelect
                              opcoes={opcoesDestino}
                              value={l.destino}
                              onChange={key => setItem(idx, { destino: key || 'novo' })}
                              placeholder="Digite pra achar o item…"
                              permitirVazio={false}
                            />
                          </div>
                          <div style={{ flex: '0 1 92px' }}>
                            <label style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>
                              Qtd {unidadeDe(l) && <span>({unidadeDe(l)})</span>}
                            </label>
                            <input inputMode="decimal" value={l.quantidade} style={{ width: '100%' }}
                              onChange={e => setItem(idx, { quantidade: e.target.value })} />
                          </div>
                          <div style={{ flex: '0 1 104px' }}>
                            <label style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>Custo un.</label>
                            <input inputMode="decimal" placeholder="—" value={l.custo_unit} style={{ width: '100%' }}
                              onChange={e => setItem(idx, { custo_unit: e.target.value })} />
                          </div>
                        </div>

                        {/* Só quando vai cadastrar: o nome que vai ficar no sistema
                            (a nota abrevia, aqui escreve por extenso) e a unidade. */}
                        {l.destino === 'novo' && (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 7 }}>
                            <div style={{ flex: '2 1 220px', minWidth: 0 }}>
                              <label style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>Nome do insumo novo</label>
                              <input value={l.nomeNovo} style={{ width: '100%' }}
                                onChange={e => setItem(idx, { nomeNovo: e.target.value })} />
                            </div>
                            <div style={{ flex: '0 1 92px' }}>
                              <label style={{ display: 'block', fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>Unidade</label>
                              <select value={l.unidadeNovo} style={{ width: '100%' }}
                                onChange={e => setItem(idx, { unidadeNovo: e.target.value })}>
                                {['kg', 'g', 'L', 'ml', 'un'].map(u => <option key={u} value={u}>{u}</option>)}
                              </select>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
                  Item novo entra como <strong>insumo</strong>. Produto de revenda precisa de preço e categoria — esse
                  tem que ser cadastrado no Catálogo antes.
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={atualizarCusto} onChange={e => setAtualizarCusto(e.target.checked)} style={{ width: 'auto' }} />
                  Atualizar o custo (produto e matéria-prima) com o valor da nota
                </label>
              </>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShow(false)}>Fechar</button>
              {step === 'revisar' && itens.length > 0 && (
                <button type="button" className="btn btn-primary" onClick={confirmar} disabled={salvando}>
                  {salvando ? 'Lançando…' : `Lançar ${nProd + nMat + nNovo} entrada(s)${nNovo ? ` (${nNovo} novo${nNovo > 1 ? 's' : ''})` : ''}`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
