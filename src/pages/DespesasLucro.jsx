import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { calcIfoodLiquido } from '../lib/ifoodLiquido'
import '../components/Page.css'

// ── helpers ───────────────────────────────────────────────────────────
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const pad = (n) => String(n).padStart(2, '0')
const mesAtual = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}` }
// Conversão pra unidade base (grama/ml/un), igual à Ficha Técnica.
const FATOR = { kg: 1000, g: 1, L: 1000, ml: 1, un: 1 }
const UNIDADES = ['kg', 'g', 'L', 'ml', 'un']
const emBase = (qtd, unidade) => Number(qtd || 0) * (FATOR[unidade] || 1)
const num = (s) => Number(String(s ?? '').replace(',', '.')) || 0

const CATEGORIAS = [
  ['aluguel', '🏠 Aluguel'], ['energia', '💡 Energia'], ['agua', '🚰 Água'],
  ['internet', '🌐 Internet'], ['gas', '🔥 Gás'], ['outros', '📦 Outros'],
]
const catLabel = (c) => (CATEGORIAS.find(([k]) => k === c)?.[1]) || '📦 Outros'

// custo por unidade base de uma ficha (custo total / rendimento em base)
function custoPorBaseFicha(ficha, itens) {
  const custoTotal = (itens || []).reduce((s, it) => s + emBase(it.quantidade, it.unidade) * Number(it.custo_unit || 0), 0)
  const rendBase = emBase(ficha.rendimento, ficha.unid_rendimento)
  return rendBase > 0 ? custoTotal / rendBase : 0
}

const emptyDespesa = { nome: '', categoria: 'energia', tipo: 'fixo', valor: '' }
const emptyFunc = { nome: '', cargo: '', salario_mensal: '' }
const emptyProd = () => ({ ficha_id: '', data: new Date().toISOString().slice(0, 10), qtd_feita: '', qtd_sobrou: '', unidade: 'kg' })

export default function DespesasLucro({ empresaId }) {
  const [mes, setMes] = useState(mesAtual())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [despesas, setDespesas] = useState([])
  const [funcionarios, setFuncionarios] = useState([])
  const [producao, setProducao] = useState([])
  const [fichas, setFichas] = useState([])         // [{id, nome, custoPorBase, unid_rendimento}]
  const [diasAbertos, setDiasAbertos] = useState(26)
  const [receita, setReceita] = useState({ proprios: 0, ifood: 0 })

  // modais
  const [showDespesa, setShowDespesa] = useState(false)
  const [despesaForm, setDespesaForm] = useState(emptyDespesa)
  const [despesaEdit, setDespesaEdit] = useState(null)
  const [showFunc, setShowFunc] = useState(false)
  const [funcForm, setFuncForm] = useState(emptyFunc)
  const [funcEdit, setFuncEdit] = useState(null)
  const [showProd, setShowProd] = useState(false)
  const [prodForm, setProdForm] = useState(emptyProd())

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setLoading(true); setError(null)
    try {
      const [y, m] = mes.split('-').map(Number)
      const ini = new Date(y, m - 1, 1)
      const fim = new Date(y, m, 1)
      const iniYMD = `${y}-${pad(m)}-01`
      const fimYMD = `${fim.getFullYear()}-${pad(fim.getMonth() + 1)}-01`

      const [dp, fn, pd, fi, fit, emp, ped] = await Promise.all([
        supabase.from('despesas_loja').select('*').eq('empresa_id', empresaId).eq('ativo', true).order('valor', { ascending: false }),
        supabase.from('funcionarios').select('*').eq('empresa_id', empresaId).eq('ativo', true).order('nome'),
        supabase.from('producao_diaria').select('*').eq('empresa_id', empresaId).gte('data', iniYMD).lt('data', fimYMD).order('data', { ascending: false }),
        supabase.from('fichas_tecnicas').select('*').eq('empresa_id', empresaId).order('nome'),
        supabase.from('ficha_itens').select('ficha_id, quantidade, unidade, custo_unit').eq('empresa_id', empresaId),
        supabase.from('empresas').select('dias_abertos_mes, ifood_comissao_pct, ifood_transacao_pct').eq('id', empresaId).maybeSingle(),
        fetchAll(() => supabase.from('pedidos_delivery')
          .select('origem, total, taxa_entrega, subtotal, ifood_valores, forma_pagamento, status')
          .neq('status', 'cancelado').gte('created_at', ini.toISOString()).lt('created_at', fim.toISOString())),
      ])
      for (const r of [dp, fn, pd, fi, fit, ped]) if (r.error) throw r.error

      setDespesas(dp.data || [])
      setFuncionarios(fn.data || [])
      setProducao(pd.data || [])
      setDiasAbertos(Number(emp.data?.dias_abertos_mes ?? 26) || 26)

      // custo por base de cada ficha
      const itensPor = {}
      for (const it of (fit.data || [])) (itensPor[it.ficha_id] = itensPor[it.ficha_id] || []).push(it)
      setFichas((fi.data || []).map(f => ({
        id: f.id, nome: f.nome, unid_rendimento: f.unid_rendimento,
        custoPorBase: custoPorBaseFicha(f, itensPor[f.id] || []),
      })))

      // receita líquida do mês (mesma conta do Financeiro)
      const peds = ped.data || []
      const proprios = peds.filter(p => ['whatsapp', 'app', 'cardapio'].includes(p.origem) || !p.origem)
        .reduce((s, p) => s + (Number(p.total || 0) - Number(p.taxa_entrega || 0)), 0)
      const ifoodPeds = peds.filter(p => p.origem === 'ifood')
      const rates = { comissao: emp.data?.ifood_comissao_pct, transacao: emp.data?.ifood_transacao_pct }
      const ifoodLiq = calcIfoodLiquido(ifoodPeds, rates)
      setReceita({ proprios, ifood: Number(ifoodLiq.voceRecebe || 0) })
    } catch (e) {
      setError(e.message || 'Erro ao carregar')
    } finally {
      setLoading(false)
    }
  }, [empresaId, mes])

  useEffect(() => { carregar() }, [carregar])

  // ── cálculos ─────────────────────────────────────────────────────
  const totalFixo = useMemo(() => despesas.reduce((s, d) => s + Number(d.valor || 0), 0), [despesas])
  const totalFunc = useMemo(() => funcionarios.reduce((s, f) => s + Number(f.salario_mensal || 0), 0), [funcionarios])
  const custoProdItem = (p) => emBase(Number(p.qtd_feita || 0) - Number(p.qtd_sobrou || 0), p.unidade) * Number(p.custo_unit || 0)
  const totalProducao = useMemo(() => producao.reduce((s, p) => s + custoProdItem(p), 0), [producao])

  const receitaLiquida = receita.proprios + receita.ifood
  const totalDespesas = totalFixo + totalFunc + totalProducao
  const lucroReal = receitaLiquida - totalDespesas
  const dias = Math.max(1, diasAbertos)
  const funcPorDia = totalFunc / dias
  const fixoPorDia = totalFixo / dias

  async function salvarDias(v) {
    const x = Math.max(1, Math.min(31, Math.round(Number(v) || 26)))
    setDiasAbertos(x)
    if (empresaId) await supabase.from('empresas').update({ dias_abertos_mes: x }).eq('id', empresaId)
  }

  // ── CRUD: despesa ──
  function abrirNovaDespesa() { setDespesaEdit(null); setDespesaForm(emptyDespesa); setShowDespesa(true) }
  function abrirEditarDespesa(d) {
    setDespesaEdit(d); setDespesaForm({ nome: d.nome, categoria: d.categoria, tipo: d.tipo, valor: String(d.valor ?? '') }); setShowDespesa(true)
  }
  async function salvarDespesa(e) {
    e.preventDefault()
    if (!despesaForm.nome.trim()) return
    const payload = { empresa_id: empresaId, nome: despesaForm.nome.trim(), categoria: despesaForm.categoria, tipo: despesaForm.tipo, valor: num(despesaForm.valor) }
    const q = despesaEdit ? supabase.from('despesas_loja').update(payload).eq('id', despesaEdit.id) : supabase.from('despesas_loja').insert(payload)
    const { error } = await q
    if (error) { alert('Erro: ' + error.message); return }
    setShowDespesa(false); carregar()
  }
  async function excluirDespesa(d) {
    if (!confirm(`Excluir "${d.nome}"?`)) return
    await supabase.from('despesas_loja').delete().eq('id', d.id); carregar()
  }

  // ── CRUD: funcionário ──
  function abrirNovoFunc() { setFuncEdit(null); setFuncForm(emptyFunc); setShowFunc(true) }
  function abrirEditarFunc(f) {
    setFuncEdit(f); setFuncForm({ nome: f.nome, cargo: f.cargo || '', salario_mensal: String(f.salario_mensal ?? '') }); setShowFunc(true)
  }
  async function salvarFunc(e) {
    e.preventDefault()
    if (!funcForm.nome.trim()) return
    const payload = { empresa_id: empresaId, nome: funcForm.nome.trim(), cargo: funcForm.cargo.trim() || null, salario_mensal: num(funcForm.salario_mensal) }
    const q = funcEdit ? supabase.from('funcionarios').update(payload).eq('id', funcEdit.id) : supabase.from('funcionarios').insert(payload)
    const { error } = await q
    if (error) { alert('Erro: ' + error.message); return }
    setShowFunc(false); carregar()
  }
  async function excluirFunc(f) {
    if (!confirm(`Excluir "${f.nome}"?`)) return
    await supabase.from('funcionarios').delete().eq('id', f.id); carregar()
  }

  // ── CRUD: produção diária ──
  function abrirNovaProd() { setProdForm(emptyProd()); setShowProd(true) }
  const fichaSel = fichas.find(f => f.id === prodForm.ficha_id)
  const prodPrevia = fichaSel ? emBase(num(prodForm.qtd_feita) - num(prodForm.qtd_sobrou), prodForm.unidade) * fichaSel.custoPorBase : 0
  async function salvarProd(e) {
    e.preventDefault()
    if (!prodForm.ficha_id) { alert('Escolha o produto (ficha técnica).'); return }
    if (!fichaSel) { alert('Ficha não encontrada.'); return }
    const payload = {
      empresa_id: empresaId, data: prodForm.data, ficha_id: prodForm.ficha_id, nome: fichaSel.nome,
      qtd_feita: num(prodForm.qtd_feita), qtd_sobrou: num(prodForm.qtd_sobrou),
      unidade: prodForm.unidade, custo_unit: fichaSel.custoPorBase,
    }
    const { error } = await supabase.from('producao_diaria').insert(payload)
    if (error) { alert('Erro: ' + error.message); return }
    setShowProd(false); carregar()
  }
  async function excluirProd(p) {
    if (!confirm(`Excluir o lançamento de ${p.nome}?`)) return
    await supabase.from('producao_diaria').delete().eq('id', p.id); carregar()
  }

  const nomeMes = new Date(mes + '-01T00:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  const mesesOpcoes = (() => {
    const arr = []; const now = new Date()
    for (let i = 0; i < 8; i++) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); arr.push([`${d.getFullYear()}-${pad(d.getMonth() + 1)}`, d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })]) }
    return arr
  })()

  if (!empresaId) return <div className="card">Selecione uma loja.</div>

  return (
    <div>
      {/* seletor de mês */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)' }}>Mês de referência:</span>
        <select value={mes} onChange={e => setMes(e.target.value)}
          style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', background: 'var(--input-bg, var(--bg))', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', textTransform: 'capitalize' }}>
          {mesesOpcoes.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 12.5, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          Dias abertos no mês
          <input type="number" min="1" max="31" value={diasAbertos} onChange={e => setDiasAbertos(e.target.value)} onBlur={e => salvarDias(e.target.value)}
            style={{ width: 60, padding: '5px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', textAlign: 'center' }} />
        </label>
      </div>

      {error && <div className="card error-text" style={{ marginBottom: 16 }}>{error}</div>}
      {loading && <div className="card">Carregando…</div>}

      {!loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ═══ LUCRO REAL ═══ */}
          <div style={{ background: 'var(--card)', border: `2px solid ${lucroReal >= 0 ? '#16a34a' : '#ef4444'}`, borderRadius: 14, padding: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14 }}>
              💰 Lucro real de {nomeMes}
            </div>
            <Linha label="Faturamento líquido (próprios + iFood)" valor={brl(receitaLiquida)} bold />
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '-4px 0 8px 2px' }}>
              próprios {brl(receita.proprios)} · iFood {brl(receita.ifood)}
            </div>
            <Linha label="− Custos fixos (aluguel, energia…)" valor={`− ${brl(totalFixo)}`} cor="var(--danger)" />
            <Linha label="− Funcionários" valor={`− ${brl(totalFunc)}`} cor="var(--danger)" />
            <Linha label="− Custo de produção (ingredientes)" valor={`− ${brl(totalProducao)}`} cor="var(--danger)" />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, marginTop: 6, borderTop: '2px solid var(--border)' }}>
              <span style={{ fontSize: 16, fontWeight: 900 }}>{lucroReal >= 0 ? '= Foi pro seu bolso' : '= Prejuízo no mês'}</span>
              <span style={{ fontSize: 26, fontWeight: 900, color: lucroReal >= 0 ? '#16a34a' : '#ef4444' }}>{brl(lucroReal)}</span>
            </div>
            {receitaLiquida > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, textAlign: 'right' }}>
                margem de {((lucroReal / receitaLiquida) * 100).toFixed(0)}% sobre o líquido
              </div>
            )}
          </div>

          {/* ═══ CUSTOS FIXOS ═══ */}
          <Secao titulo="💡 Custos fixos e variáveis" acao={<button className="btn btn-primary btn-sm" onClick={abrirNovaDespesa}>+ Novo custo</button>}
            rodape={despesas.length > 0 && <>Total <strong>{brl(totalFixo)}</strong>/mês · <strong>{brl(fixoPorDia)}</strong>/dia</>}>
            {despesas.length === 0 ? <Vazio texto="Cadastre aluguel, energia, água, internet…" />
              : despesas.map(d => (
                <ItemLinha key={d.id} onEdit={() => abrirEditarDespesa(d)} onDel={() => excluirDespesa(d)}
                  titulo={<>{catLabel(d.categoria)} — {d.nome}</>}
                  sub={d.tipo === 'variavel' ? 'variável' : 'fixo'} valor={brl(d.valor) + '/mês'} />
              ))}
          </Secao>

          {/* ═══ FUNCIONÁRIOS ═══ */}
          <Secao titulo="👥 Funcionários" acao={<button className="btn btn-primary btn-sm" onClick={abrirNovoFunc}>+ Funcionário</button>}
            rodape={funcionarios.length > 0 && <>Total <strong>{brl(totalFunc)}</strong>/mês · custo por dia <strong>{brl(funcPorDia)}</strong> ({dias} dias)</>}>
            {funcionarios.length === 0 ? <Vazio texto="Cadastre cada funcionário com o salário." />
              : funcionarios.map(f => (
                <ItemLinha key={f.id} onEdit={() => abrirEditarFunc(f)} onDel={() => excluirFunc(f)}
                  titulo={f.nome} sub={f.cargo || 'sem cargo'} valor={brl(f.salario_mensal) + '/mês'} />
              ))}
          </Secao>

          {/* ═══ PRODUÇÃO DIÁRIA ═══ */}
          <Secao titulo={`🍲 Custo de produção — ${nomeMes}`} acao={<button className="btn btn-primary btn-sm" onClick={abrirNovaProd} disabled={fichas.length === 0}>+ Lançar produção</button>}
            rodape={producao.length > 0 && <>Custo de produção do mês <strong>{brl(totalProducao)}</strong></>}>
            {fichas.length === 0 && <Vazio texto="Crie fichas técnicas primeiro (Catálogo → Ficha Técnica) pra puxar o custo por kg." />}
            {fichas.length > 0 && producao.length === 0 && <Vazio texto={"Lance a produção do dia (ex.: fiz 10kg de feijão, sobrou 2kg)."} />}
            {producao.map(p => {
              const consumido = Number(p.qtd_feita || 0) - Number(p.qtd_sobrou || 0)
              return (
                <ItemLinha key={p.id} onDel={() => excluirProd(p)}
                  titulo={<>{p.nome} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {new Date(p.data + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span></>}
                  sub={`fez ${p.qtd_feita}${p.unidade} · sobrou ${p.qtd_sobrou}${p.unidade} · usou ${consumido}${p.unidade}`}
                  valor={brl(custoProdItem(p))} />
              )
            })}
          </Secao>
        </div>
      )}

      {/* ─── MODAL: despesa ─── */}
      {showDespesa && (
        <Modal onClose={() => setShowDespesa(false)} onSubmit={salvarDespesa} titulo={despesaEdit ? 'Editar custo' : 'Novo custo'}>
          <div className="form-grid">
            <div className="form-field full"><label>Nome</label>
              <input autoFocus placeholder="Ex.: Conta de luz" value={despesaForm.nome} onChange={e => setDespesaForm(f => ({ ...f, nome: e.target.value }))} /></div>
            <div className="form-field"><label>Categoria</label>
              <select value={despesaForm.categoria} onChange={e => setDespesaForm(f => ({ ...f, categoria: e.target.value }))}>
                {CATEGORIAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></div>
            <div className="form-field"><label>Tipo</label>
              <select value={despesaForm.tipo} onChange={e => setDespesaForm(f => ({ ...f, tipo: e.target.value }))}>
                <option value="fixo">Fixo (todo mês igual)</option>
                <option value="variavel">Variável (muda todo mês)</option>
              </select></div>
            <div className="form-field full"><label>Valor por mês (R$)</label>
              <input inputMode="decimal" placeholder="Ex.: 350,00" value={despesaForm.valor} onChange={e => setDespesaForm(f => ({ ...f, valor: e.target.value }))} /></div>
          </div>
        </Modal>
      )}

      {/* ─── MODAL: funcionário ─── */}
      {showFunc && (
        <Modal onClose={() => setShowFunc(false)} onSubmit={salvarFunc} titulo={funcEdit ? 'Editar funcionário' : 'Novo funcionário'}>
          <div className="form-grid">
            <div className="form-field full"><label>Nome</label>
              <input autoFocus placeholder="Ex.: Maria" value={funcForm.nome} onChange={e => setFuncForm(f => ({ ...f, nome: e.target.value }))} /></div>
            <div className="form-field"><label>Cargo (opcional)</label>
              <input placeholder="Ex.: Cozinheira" value={funcForm.cargo} onChange={e => setFuncForm(f => ({ ...f, cargo: e.target.value }))} /></div>
            <div className="form-field"><label>Salário por mês (R$)</label>
              <input inputMode="decimal" placeholder="Ex.: 1500,00" value={funcForm.salario_mensal} onChange={e => setFuncForm(f => ({ ...f, salario_mensal: e.target.value }))} /></div>
          </div>
        </Modal>
      )}

      {/* ─── MODAL: produção diária ─── */}
      {showProd && (
        <Modal onClose={() => setShowProd(false)} onSubmit={salvarProd} titulo="Lançar produção do dia" submitLabel="Salvar lançamento">
          <div className="form-grid">
            <div className="form-field"><label>Produto (ficha técnica)</label>
              <select value={prodForm.ficha_id} onChange={e => setProdForm(f => ({ ...f, ficha_id: e.target.value }))}>
                <option value="">— escolher —</option>
                {fichas.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </select></div>
            <div className="form-field"><label>Data</label>
              <input type="date" value={prodForm.data} onChange={e => setProdForm(f => ({ ...f, data: e.target.value }))} /></div>
            <div className="form-field"><label>Quanto fez</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input inputMode="decimal" placeholder="Ex.: 10" value={prodForm.qtd_feita} onChange={e => setProdForm(f => ({ ...f, qtd_feita: e.target.value }))} style={{ flex: 1 }} />
                <select value={prodForm.unidade} onChange={e => setProdForm(f => ({ ...f, unidade: e.target.value }))} style={{ width: 70 }}>
                  {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div></div>
            <div className="form-field"><label>Quanto sobrou</label>
              <input inputMode="decimal" placeholder="Ex.: 2" value={prodForm.qtd_sobrou} onChange={e => setProdForm(f => ({ ...f, qtd_sobrou: e.target.value }))} /></div>
          </div>
          <div className="card" style={{ marginTop: 16, background: 'var(--bg)' }}>
            {fichaSel ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13 }}>Usou {Math.max(0, num(prodForm.qtd_feita) - num(prodForm.qtd_sobrou))}{prodForm.unidade} · custo do dia</span>
                <strong style={{ fontSize: 20, color: 'var(--primary)' }}>{brl(prodPrevia)}</strong>
              </div>
            ) : <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Escolha o produto pra ver o custo do dia.</span>}
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── componentes auxiliares ────────────────────────────────────────────
function Linha({ label, valor, cor, bold }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
      <span style={{ fontSize: 13.5, color: cor || 'var(--text)', fontWeight: bold ? 700 : 400 }}>{label}</span>
      <strong style={{ fontSize: 14.5, color: cor || 'var(--text)' }}>{valor}</strong>
    </div>
  )
}
function Secao({ titulo, acao, rodape, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <strong style={{ fontSize: 15 }}>{titulo}</strong>
        {acao}
      </div>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 16px' }}>
        {children}
      </div>
      {rodape && <div style={{ textAlign: 'right', fontSize: 13, color: 'var(--text-muted)', marginTop: 8, paddingRight: 4 }}>{rodape}</div>}
    </div>
  )
}
function ItemLinha({ titulo, sub, valor, onEdit, onDel }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{titulo}</div>
        {sub && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{sub}</div>}
      </div>
      <strong style={{ fontSize: 14, whiteSpace: 'nowrap' }}>{valor}</strong>
      <div style={{ display: 'flex', gap: 6 }}>
        {onEdit && <button className="btn btn-secondary btn-sm" onClick={onEdit}>Editar</button>}
        <button className="btn btn-danger btn-sm" onClick={onDel}>✕</button>
      </div>
    </div>
  )
}
function Vazio({ texto }) {
  return <div style={{ padding: '18px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{texto}</div>
}
function Modal({ titulo, onClose, onSubmit, submitLabel = 'Salvar', children }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal" onSubmit={onSubmit}>
        <h2>{titulo}</h2>
        {children}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn-primary">{submitLabel}</button>
        </div>
      </form>
    </div>
  )
}
