import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// Consumo de funcionário (alimentação): lança o que o funcionário pega (item do
// estoque ou refeição avulsa). Item do estoque dá baixa e usa o preço de venda.
// Relatório à parte — NÃO entra no lucro. Reaproveitado no Financeiro e no Salão.
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const num = (s) => Number(String(s ?? '').replace(',', '.')) || 0
const semAcento = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const emptyForm = { funcionario_id: '', tipo: 'produto', produto_id: '', busca: '', descricao: '', quantidade: '1', valor_unitario: '' }

export default function ConsumoFuncionario({ empresaId }) {
  const [consumos, setConsumos] = useState([])
  const [produtos, setProdutos] = useState([])
  const [funcionarios, setFuncionarios] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [salvando, setSalvando] = useState(false)

  async function load() {
    if (!empresaId) return
    setLoading(true)
    const iniMes = new Date(); iniMes.setDate(1); iniMes.setHours(0, 0, 0, 0)
    const [co, prc, fn] = await Promise.all([
      supabase.from('consumo_funcionario').select('*').eq('empresa_id', empresaId).gte('created_at', iniMes.toISOString()).order('created_at', { ascending: false }),
      supabase.from('produtos').select('id, nome, preco_venda, controla_estoque').eq('empresa_id', empresaId).eq('ativo', true).order('nome').limit(1000),
      supabase.from('funcionarios').select('id, nome').eq('empresa_id', empresaId).eq('ativo', true).order('nome'),
    ])
    setConsumos(co.data || [])
    setProdutos(prc.data || [])
    setFuncionarios(fn.data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  const total = useMemo(() => consumos.reduce((s, c) => s + Number(c.valor_total || 0), 0), [consumos])
  const prodSel = produtos.find(p => p.id === form.produto_id)
  const filtrados = useMemo(() => {
    const q = semAcento(form.busca); if (!q) return []
    return produtos.filter(p => semAcento(p.nome).includes(q)).slice(0, 20)
  }, [produtos, form.busca])
  const qtd = Math.max(1, num(form.quantidade) || 1)
  const unit = num(form.valor_unitario)
  const totalPrev = unit * qtd

  function abrir() { setForm(emptyForm); setShowModal(true) }
  function escolherProd(p) {
    setForm(f => ({ ...f, produto_id: p.id, descricao: p.nome, busca: p.nome, valor_unitario: String(Number(p.preco_venda || 0)).replace('.', ',') }))
  }
  async function salvar(e) {
    e.preventDefault()
    if (form.tipo === 'produto' && !form.produto_id) { alert('Escolha o produto do estoque.'); return }
    if (form.tipo === 'avulso' && !form.descricao.trim()) { alert('Descreva o item (ex.: Almoço).'); return }
    setSalvando(true)
    const { error } = await supabase.rpc('registrar_consumo_funcionario', {
      p_funcionario_id: form.funcionario_id || null,
      p_produto_id: form.tipo === 'produto' ? form.produto_id : null,
      p_descricao: form.descricao.trim() || null,
      p_quantidade: qtd,
      p_valor_unitario: form.valor_unitario === '' ? null : unit,
      p_observacao: null,
    })
    setSalvando(false)
    if (error) { window.alert('Erro ao lançar o consumo: ' + error.message); return }
    setShowModal(false); load()
  }
  async function excluir(c) {
    if (!window.confirm(`Excluir o consumo "${c.descricao}"${c.baixou_estoque ? ' (o estoque será devolvido)' : ''}?`)) return
    const { error } = await supabase.rpc('excluir_consumo_funcionario', { p_id: c.id })
    if (error) { window.alert('Erro: ' + error.message); return }
    load()
  }

  const vazioStyle = { padding: '18px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15 }}>🍽️ Consumo de funcionários (este mês)</strong>
        <button type="button" className="btn btn-primary btn-sm" onClick={abrir}>+ Lançar consumo</button>
      </div>

      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 16px' }}>
        {loading ? (
          <div style={vazioStyle}>Carregando…</div>
        ) : consumos.length === 0 ? (
          <div style={vazioStyle}>Nada lançado este mês. Lance o que o funcionário pega (almoço, refri do estoque…). Dá baixa no estoque e soma o gasto do mês.</div>
        ) : consumos.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{Number(c.quantidade) > 1 ? `${c.quantidade}× ` : ''}{c.descricao}{c.baixou_estoque ? ' 📦' : ''}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{c.funcionario_nome || 'sem funcionário'} · {new Date(c.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</div>
            </div>
            <strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>{brl(c.valor_total)}</strong>
            <button className="btn btn-danger btn-sm" onClick={() => excluir(c)}>✕</button>
          </div>
        ))}
      </div>

      {consumos.length > 0 && (
        <div style={{ textAlign: 'right', fontSize: 13, color: 'var(--text-muted)', marginTop: 8, paddingRight: 4 }}>
          Gasto com alimentação no mês <strong>{brl(total)}</strong> · não entra no lucro
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowModal(false) }} style={{ zIndex: 1200 }}>
          <form className="modal" onSubmit={salvar}>
            <h2>Lançar consumo de funcionário</h2>

            <div className="form-grid">
              <div className="form-field full"><label>Funcionário (opcional)</label>
                <select value={form.funcionario_id} onChange={e => setForm(f => ({ ...f, funcionario_id: e.target.value }))}>
                  <option value="">— sem funcionário / geral —</option>
                  {funcionarios.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, margin: '4px 0 12px' }}>
              {[['produto', '📦 Item do estoque'], ['avulso', '🍽️ Refeição / avulso']].map(([id, lb]) => (
                <button key={id} type="button" onClick={() => setForm(f => ({ ...emptyForm, funcionario_id: f.funcionario_id, tipo: id }))}
                  style={{ flex: 1, padding: '9px 8px', borderRadius: 8, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                    background: form.tipo === id ? 'var(--primary)' : 'transparent', color: form.tipo === id ? '#fff' : 'var(--text)' }}>
                  {lb}
                </button>
              ))}
            </div>

            {form.tipo === 'produto' ? (
              <div className="form-field full" style={{ marginBottom: 12 }}>
                <label>Produto do estoque</label>
                {prodSel ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontWeight: 700 }}>{prodSel.nome}{prodSel.controla_estoque ? '' : ' (sem controle de estoque)'}</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm(f => ({ ...f, produto_id: '', busca: '', descricao: '' }))}>Trocar</button>
                  </div>
                ) : (
                  <>
                    <input autoFocus placeholder="Buscar produto..." value={form.busca}
                      onChange={e => setForm(f => ({ ...f, busca: e.target.value }))} />
                    {filtrados.length > 0 && (
                      <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginTop: 4 }}>
                        {filtrados.map(p => (
                          <button key={p.id} type="button" onClick={() => escolherProd(p)}
                            style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, textAlign: 'left', padding: '8px 10px', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 14 }}>
                            <span>{p.nome}</span><span style={{ color: 'var(--text-muted)' }}>{brl(p.preco_venda)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="form-field full" style={{ marginBottom: 12 }}>
                <label>O que consumiu</label>
                <input autoFocus placeholder="Ex.: Almoço" value={form.descricao}
                  onChange={e => setForm(f => ({ ...f, descricao: e.target.value }))} />
              </div>
            )}

            <div className="form-grid">
              <div className="form-field"><label>Quantidade</label>
                <input inputMode="decimal" value={form.quantidade} onChange={e => setForm(f => ({ ...f, quantidade: e.target.value }))} /></div>
              <div className="form-field"><label>Valor unitário (R$)</label>
                <input inputMode="decimal" placeholder="0,00" value={form.valor_unitario} onChange={e => setForm(f => ({ ...f, valor_unitario: e.target.value }))} /></div>
            </div>

            <div className="card" style={{ marginTop: 12, background: 'var(--bg)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13 }}>Total{form.tipo === 'produto' && prodSel?.controla_estoque ? ' · dá baixa no estoque' : ''}</span>
              <strong style={{ fontSize: 20, color: 'var(--primary)' }}>{brl(totalPrev)}</strong>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancelar</button>
              <button type="submit" className="btn btn-primary" disabled={salvando}>{salvando ? 'Salvando…' : 'Lançar'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
