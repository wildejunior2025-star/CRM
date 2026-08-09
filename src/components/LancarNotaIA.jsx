import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// Botão "Lançar nota (IA)": tira foto/PDF da nota de compra, a IA lê e casa cada item
// com PRODUTO (revenda) ou MATÉRIA-PRIMA (insumo), dando entrada no estoque certo.
// Reaproveitado no Estoque e na Ficha Técnica (a nota do mercado vem misturada).
export default function LancarNotaIA({ empresaId, onDone }) {
  const [show, setShow] = useState(false)
  const [step, setStep] = useState('upload') // 'upload' | 'lendo' | 'revisar'
  const [produtos, setProdutos] = useState([])
  const [materias, setMaterias] = useState([])
  const [itens, setItens] = useState([])   // [{ tipo, id, nome, quantidade, custo_unit, incluir }]
  const [naoEnc, setNaoEnc] = useState([])
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)
  const [atualizarCusto, setAtualizarCusto] = useState(true)
  const [salvando, setSalvando] = useState(false)

  async function abrir() {
    setStep('upload'); setItens([]); setNaoEnc([]); setErro(null); setAviso(null); setAtualizarCusto(true); setShow(true)
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
      setItens((data.itens || []).map(it => ({
        ...it,
        quantidade: String(it.quantidade),
        custo_unit: it.custo_unit != null ? String(it.custo_unit).replace('.', ',') : '',
        incluir: true,
      })))
      // Item que não está no cadastro vira uma linha editável pra criar na hora como insumo.
      setNaoEnc((data.nao_encontrados || []).map(n => ({
        nome: n.nome || '',
        unidade: n.unidade || 'un',
        quantidade: String(n.quantidade ?? ''),
        custo_unit: n.custo_unit != null ? String(n.custo_unit).replace('.', ',') : '',
        criar: true,
      })))
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

  const uniMateria = (id) => materias.find(m => m.id === id)?.unidade || ''
  const setItem = (idx, patch) => setItens(arr => arr.map((x, i) => i === idx ? { ...x, ...patch } : x))
  const setNovo = (idx, patch) => setNaoEnc(arr => arr.map((x, i) => i === idx ? { ...x, ...patch } : x))
  const num = (v) => Number(String(v).replace(',', '.'))

  // Cadastra como matéria-prima os itens que a IA não achou e o lojista marcou.
  // Devolve as linhas prontas pra entrada de estoque. Se o nome já existir, reusa o
  // cadastro em vez de criar repetido.
  async function criarNovosInsumos() {
    const criar = naoEnc.filter(n => n.criar && n.nome.trim() && num(n.quantidade) > 0)
    if (!criar.length) return []
    const norm = (s) => (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
    const linhas = []
    for (const n of criar) {
      const nome = n.nome.trim()
      const custo = num(n.custo_unit)
      const jaTem = materias.find(m => norm(m.nome) === norm(nome))
      let id = jaTem?.id
      if (id && atualizarCusto && Number.isFinite(custo) && custo > 0) {
        await supabase.from('materias_primas').update({ custo }).eq('id', id)
      }
      if (!id) {
        const { data, error } = await supabase.from('materias_primas')
          .insert({ empresa_id: empresaId, nome, unidade: n.unidade, custo: Number.isFinite(custo) && custo > 0 ? custo : 0 })
          .select('id').single()
        if (error) throw new Error(`Não deu pra criar "${nome}": ${error.message}`)
        id = data.id
      }
      linhas.push({ empresa_id: empresaId, materia_prima_id: id, tipo: 'entrada', quantidade: num(n.quantidade) })
    }
    return linhas
  }

  async function confirmar() {
    const inc = itens.filter(it => it.incluir && num(it.quantidade) > 0)
    const novos = naoEnc.filter(n => n.criar && n.nome.trim() && num(n.quantidade) > 0)
    if (!inc.length && !novos.length) { setErro('Marque ao menos um item pra lançar.'); return }
    setSalvando(true); setErro(null)
    const prodLinhas = inc.filter(it => it.tipo === 'produto').map(it => ({
      produto_id: it.id, tipo: 'entrada', quantidade: Number(String(it.quantidade).replace(',', '.')),
      motivo: 'compra', observacao: 'Nota de compra (IA)',
    }))
    const matLinhas = inc.filter(it => it.tipo === 'materia').map(it => ({
      empresa_id: empresaId, materia_prima_id: it.id, tipo: 'entrada',
      quantidade: Number(String(it.quantidade).replace(',', '.')),
    }))
    try {
      const linhasNovas = await criarNovosInsumos()
      const todasMat = [...matLinhas, ...linhasNovas]
      if (prodLinhas.length) { const { error } = await supabase.from('estoque_movimentos').insert(prodLinhas); if (error) throw error }
      if (todasMat.length) { const { error } = await supabase.from('materia_prima_movimentos').insert(todasMat); if (error) throw error }
      if (atualizarCusto) {
        for (const it of inc) {
          const custo = Number(String(it.custo_unit).replace(',', '.'))
          if (Number.isFinite(custo) && custo > 0) {
            if (it.tipo === 'produto') await supabase.from('produtos').update({ preco_custo: custo }).eq('id', it.id)
            else await supabase.from('materias_primas').update({ custo }).eq('id', it.id)
          }
        }
      }
    } catch (e) {
      setSalvando(false); setErro('Erro ao lançar: ' + e.message); return
    }
    setSalvando(false); setShow(false)
    if (onDone) onDone()
  }

  const nProd = itens.filter(it => it.incluir && it.tipo === 'produto').length
  const nMat = itens.filter(it => it.incluir && it.tipo === 'materia').length
  const nNovo = naoEnc.filter(n => n.criar && n.nome.trim() && num(n.quantidade) > 0).length

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
                <p style={{ fontSize: 13.5, color: 'var(--text-muted)' }}>Confira os itens, ajuste quantidade/custo e confirme. Só entra o que estiver marcado.</p>
                {aviso && (
                  <div style={{
                    margin: '8px 0', padding: '8px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                    background: 'rgba(217,119,6,.12)', color: '#b45309', border: '1px solid rgba(217,119,6,.4)',
                  }}>⚠️ {aviso}</div>
                )}
                {itens.length === 0 ? (
                  <div className="empty-state">
                    Nenhum item da nota bateu com o que você já tem cadastrado.
                    {naoEnc.length > 0 && ' Dá pra criar tudo abaixo.'}
                  </div>
                ) : (
                  <div className="data-table" style={{ marginTop: 8 }}>
                    <table style={{ width: '100%' }}>
                      <thead><tr>
                        <th style={{ width: 34 }}></th><th>Item</th><th style={{ width: 96 }}>Tipo</th><th style={{ width: 96 }}>Qtd</th><th style={{ width: 110 }}>Custo un.</th>
                      </tr></thead>
                      <tbody>
                        {itens.map((it, idx) => (
                          <tr key={idx} style={{ opacity: it.incluir ? 1 : .5 }}>
                            <td><input type="checkbox" checked={it.incluir} onChange={e => setItem(idx, { incluir: e.target.checked })} /></td>
                            <td>{it.nome}</td>
                            <td>
                              <span className="badge" style={{ background: it.tipo === 'produto' ? 'rgba(37,99,235,.12)' : 'rgba(22,163,74,.12)', color: it.tipo === 'produto' ? '#2563eb' : '#15803d', fontWeight: 700 }}>
                                {it.tipo === 'produto' ? 'Produto' : 'Insumo'}
                              </span>
                            </td>
                            <td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <input inputMode="decimal" value={it.quantidade} onChange={e => setItem(idx, { quantidade: e.target.value })} style={{ width: 56 }} />
                                {it.tipo === 'materia' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{uniMateria(it.id)}</span>}
                              </div>
                            </td>
                            <td><input inputMode="decimal" placeholder="—" value={it.custo_unit} onChange={e => setItem(idx, { custo_unit: e.target.value })} style={{ width: 96 }} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {naoEnc.length > 0 && (
                  <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(217,119,6,.1)', border: '1px solid #d97706' }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: '#b45309', marginBottom: 6 }}>
                      ⚠️ Não achei no seu cadastro — marque pra criar como insumo já com a entrada:
                    </div>
                    <div className="data-table">
                      <table style={{ width: '100%' }}>
                        <thead><tr>
                          <th style={{ width: 34 }}></th><th>Nome (dá pra corrigir)</th><th style={{ width: 70 }}>Un.</th><th style={{ width: 80 }}>Qtd</th><th style={{ width: 104 }}>Custo un.</th>
                        </tr></thead>
                        <tbody>
                          {naoEnc.map((n, i) => (
                            <tr key={i} style={{ opacity: n.criar ? 1 : .5 }}>
                              <td><input type="checkbox" checked={!!n.criar} onChange={e => setNovo(i, { criar: e.target.checked })} /></td>
                              <td><input value={n.nome} onChange={e => setNovo(i, { nome: e.target.value })} style={{ width: '100%' }} /></td>
                              <td>
                                <select value={n.unidade} onChange={e => setNovo(i, { unidade: e.target.value })} style={{ width: '100%' }}>
                                  {['kg', 'g', 'L', 'ml', 'un'].map(u => <option key={u} value={u}>{u}</option>)}
                                </select>
                              </td>
                              <td><input inputMode="decimal" value={n.quantidade} onChange={e => setNovo(i, { quantidade: e.target.value })} style={{ width: '100%' }} /></td>
                              <td><input inputMode="decimal" placeholder="—" value={n.custo_unit} onChange={e => setNovo(i, { custo_unit: e.target.value })} style={{ width: '100%' }} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
                      Entram como <strong>insumo</strong> (matéria-prima). Produto de revenda precisa de preço e categoria — esse tem que ser cadastrado no Catálogo.
                    </div>
                  </div>
                )}

                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={atualizarCusto} onChange={e => setAtualizarCusto(e.target.checked)} style={{ width: 'auto' }} />
                  Atualizar o custo (produto e matéria-prima) com o valor da nota
                </label>
              </>
            )}

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShow(false)}>Fechar</button>
              {step === 'revisar' && (itens.length > 0 || naoEnc.length > 0) && (
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
