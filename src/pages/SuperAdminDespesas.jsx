import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'
import './SuperAdminDespesas.css'

const fmt = (v, moeda = 'BRL') =>
  Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: moeda })

const CATEGORIAS = [
  { valor: 'infra',      label: 'Infraestrutura', cor: '#3b82f6' },
  { valor: 'dominio',    label: 'Domínio',        cor: '#8b5cf6' },
  { valor: 'pagamentos', label: 'Pagamentos',     cor: '#16a34a' },
  { valor: 'app',        label: 'App / Loja',     cor: '#f97316' },
  { valor: 'ia',         label: 'IA',             cor: '#e11d48' },
  { valor: 'contador',   label: 'Contador',       cor: '#0891b2' },
  { valor: 'outro',      label: 'Outro',          cor: '#6b7280' },
]
const catInfo = c => CATEGORIAS.find(x => x.valor === c) || CATEGORIAS[6]

const RECORRENCIAS = [
  { valor: 'mensal',  label: 'Mensal'  },
  { valor: 'anual',   label: 'Anual'   },
  { valor: 'unico',   label: 'Única'   },
  { valor: 'por_uso', label: 'Por uso' },
]
const recLabel = r => (RECORRENCIAS.find(x => x.valor === r) || {}).label || r

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

function hojeISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const mesRef = () => hojeISO().slice(0, 7)   // "2026-09"

function diasAte(dataStr) {
  if (!dataStr) return null
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0)
  return Math.round((new Date(dataStr + 'T00:00:00') - hoje) / 86400000)
}
const dataBR = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : ''

// ── Gastos do mês ────────────────────────────────────────────────────────────
// A barra usa a coluna `pago_em`: pagou, marca a data; a soma do que está pago
// no mês corrente é o quanto ela enche. Vira o mês, `pago_em` fica no mês
// anterior e tudo volta a "em aberto" sozinho — sem cron, sem zerar nada.
const pagoEsteMes = d => !!d.pago_em && String(d.pago_em).slice(0, 7) === mesRef()

// Entra na conta do mês: mensal sempre; anual/única só no mês em que vence.
// "Por uso" fica de fora — não tem valor fechado pra cobrar.
const contaNoMes = d =>
  !!d.ativo &&
  d.moeda === 'BRL' &&
  Number(d.valor || 0) > 0 &&
  (d.recorrencia === 'mensal' ||
    ((d.recorrencia === 'anual' || d.recorrencia === 'unico') &&
      String(d.data_vencimento || '').slice(0, 7) === mesRef()))

// Cotação só pra dar uma ideia do que a mensalidade viraria em real — o preço
// de verdade é em dólar e sai no cartão convertido pelo câmbio do dia.
const USD_BRL = 5.4
const nomeEhCloudflare = n => /cloudflare/i.test(n || '')

// vencida primeiro, depois a que vence antes, sem data no fim
const porVencimento = (a, b) => {
  const va = a.data_vencimento || '9999-12-31'
  const vb = b.data_vencimento || '9999-12-31'
  return va < vb ? -1 : va > vb ? 1 : 0
}

export default function SuperAdminDespesas() {
  const [lista, setLista]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [savingId, setSavingId] = useState(null)
  const [editId, setEditId]     = useState(null)
  const [verInativas, setVerInativas] = useState(false)

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('despesas_sistema')
      .select('*')
      .order('ativo', { ascending: false })
      .order('categoria')
      .order('nome')
    setLista(data ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function salvar(id, patch) {
    setSavingId(id)
    setLista(l => l.map(d => d.id === id ? { ...d, ...patch } : d))   // otimista
    await supabase.from('despesas_sistema')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
    setSavingId(null)
  }

  async function adicionar() {
    const { data } = await supabase.from('despesas_sistema')
      .insert({ nome: 'Nova despesa', categoria: 'outro', recorrencia: 'mensal' })
      .select().single()
    if (data) { setLista(l => [...l, data]); setEditId(data.id) }
  }

  async function excluir(id) {
    if (!confirm('Excluir esta despesa da lista?')) return
    setLista(l => l.filter(d => d.id !== id))
    await supabase.from('despesas_sistema').delete().eq('id', id)
  }

  const ativas = lista.filter(d => d.ativo)
  const totalMensalBRL = ativas
    .filter(d => d.recorrencia === 'mensal' && d.moeda === 'BRL')
    .reduce((s, d) => s + Number(d.valor || 0), 0)
  const totalAnualBRL = ativas
    .filter(d => d.recorrencia === 'anual' && d.moeda === 'BRL')
    .reduce((s, d) => s + Number(d.valor || 0), 0)
  const custoMensalAprox = totalMensalBRL + totalAnualBRL / 12
  const comAlerta = ativas.filter(d => d.alerta_ativo).length

  // Barra do mês
  const doMes    = lista.filter(contaNoMes).sort(porVencimento)
  const totalMes = doMes.reduce((s, d) => s + Number(d.valor || 0), 0)
  const pagoMes  = doMes.filter(pagoEsteMes).reduce((s, d) => s + Number(d.valor || 0), 0)
  const faltaMes = Math.max(0, totalMes - pagoMes)
  const pctMes   = totalMes > 0 ? Math.min(100, Math.round((pagoMes / totalMes) * 100)) : 0
  const quitado  = totalMes > 0 && faltaMes < 0.01
  const qtdPagas = doMes.filter(pagoEsteMes).length

  const porUso   = ativas.filter(d => d.recorrencia === 'por_uso')
  const outras   = ativas.filter(d => d.recorrencia !== 'por_uso' && !contaNoMes(d)).sort(porVencimento)
  const inativas = lista.filter(d => !d.ativo)

  const cardProps = { salvar, excluir, editId, setEditId, savingId, setLista }

  return (
    <div className="page-container">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 className="page-title">Despesas do sistema</h1>
        <button className="btn btn-primary btn-sm" onClick={adicionar}>+ Nova despesa</button>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: -8, marginBottom: 20 }}>
        O que <strong>você paga</strong> para manter a plataforma no ar. Marque cada conta como paga
        conforme for pagando — na virada do mês tudo volta a ficar em aberto sozinho.
      </p>

      {/* Hero — quanto falta pagar neste mês */}
      {totalMes > 0 && (
        <div className="desp-hero">
          <div className="desp-hero-top">
            <div>
              <div className="desp-hero-label">Contas de {MESES[new Date().getMonth()]}</div>
              <div className="desp-hero-valor">
                {quitado ? 'Tudo pago! 🎉' : `Faltam ${fmt(faltaMes)}`}
              </div>
            </div>
            <div className="desp-hero-pct">{pctMes}%</div>
          </div>
          <div className="desp-bar">
            <div className={`desp-bar-fill${quitado ? ' ok' : ''}`} style={{ width: `${pctMes}%` }} />
          </div>
          <div className="desp-hero-sub">
            {fmt(pagoMes)} pagos de {fmt(totalMes)} · {qtdPagas} de {doMes.length} contas
          </div>
        </div>
      )}

      <div className="desp-stats">
        <div className="desp-stat">
          <div className="desp-stat-label">Custo mensal aprox.</div>
          <div className="desp-stat-valor">{fmt(custoMensalAprox)}</div>
          <div className="desp-stat-hint">mensais + anuais ÷ 12</div>
        </div>
        <div className="desp-stat">
          <div className="desp-stat-label">Total mensal</div>
          <div className="desp-stat-valor">{fmt(totalMensalBRL)}</div>
          <div className="desp-stat-hint">contas que repetem todo mês</div>
        </div>
        <div className="desp-stat">
          <div className="desp-stat-label">Total anual</div>
          <div className="desp-stat-valor">{fmt(totalAnualBRL)}</div>
          <div className="desp-stat-hint">cobradas uma vez por ano</div>
        </div>
        <div className="desp-stat">
          <div className="desp-stat-label">Alertas ligados</div>
          <div className="desp-stat-valor">
            {comAlerta}<span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}> / {ativas.length}</span>
          </div>
          <div className="desp-stat-hint">avisam antes de vencer</div>
        </div>
      </div>

      {loading ? (
        <div className="empty-state">Carregando…</div>
      ) : lista.length === 0 ? (
        <div className="empty-state">Nenhuma despesa cadastrada. Clique em “+ Nova despesa”.</div>
      ) : (
        <>
          {doMes.length > 0 && (
            <>
              <div className="desp-secao">A pagar este mês</div>
              <div className="desp-lista">
                {doMes.map(d => <Despesa key={d.id} d={d} {...cardProps} />)}
              </div>
            </>
          )}

          {outras.length > 0 && (
            <>
              <div className="desp-secao">Outras contas</div>
              <div className="desp-lista">
                {outras.map(d => <Despesa key={d.id} d={d} {...cardProps} />)}
              </div>
            </>
          )}

          {porUso.length > 0 && (
            <>
              <div className="desp-secao">Cobram por uso — sem vencimento fixo</div>
              <div className="desp-lista">
                {porUso.map(d => <Despesa key={d.id} d={d} {...cardProps} />)}
              </div>
            </>
          )}

          {inativas.length > 0 && (
            <>
              <div className="desp-secao">
                <button className="desp-secao-btn" onClick={() => setVerInativas(v => !v)}>
                  {verInativas ? '▾' : '▸'} Inativas ({inativas.length})
                </button>
              </div>
              {verInativas && (
                <div className="desp-lista">
                  {inativas.map(d => <Despesa key={d.id} d={d} {...cardProps} />)}
                </div>
              )}
            </>
          )}
        </>
      )}

      <p className="desp-rodape">
        Serviços “por uso” (Mercado Pago, Efí, IA, WhatsApp Cloud) cobram por transação, então ficam
        aqui só como referência de custo — não entram na conta do mês.
      </p>
    </div>
  )
}

/* ── Barra do consumo do Cloudflare ───────────────────────────────────────────
   O plano grátis dá 100 mil requisições por dia somando todos os workers da
   conta. A barra mostra o pico dos últimos 7 dias, que é o que conta pra saber
   se está chegando perto — e quanto custaria a mensalidade se passar.        */
function UsoCloudflare() {
  const [uso, setUso] = useState(null)

  useEffect(() => {
    let vivo = true
    supabase.functions.invoke('cloudflare-uso')
      .then(({ data, error }) => { if (vivo) setUso(error ? { ok: false } : (data ?? { ok: false })) })
      .catch(() => { if (vivo) setUso({ ok: false }) })
    return () => { vivo = false }
  }, [])

  if (!uso) return <div className="desp-uso"><span className="desp-uso-titulo">medindo o consumo…</span></div>
  if (!uso.ok) {
    return (
      <div className="desp-uso">
        <span className="desp-uso-titulo">
          {uso.motivo === 'sem_token'
            ? '⚙️ Falta cadastrar o token do Cloudflare pra mostrar o consumo aqui.'
            : '⚠️ Não consegui ler o consumo do Cloudflare agora.'}
        </span>
      </div>
    )
  }

  const pct   = uso.pct_pico ?? 0
  const nivel = pct >= 80 ? 'perigo' : pct >= 50 ? 'atencao' : 'ok'
  const mil   = n => Number(n || 0).toLocaleString('pt-BR')
  const maxDia = Math.max(1, ...(uso.dias || []).map(d => d.requisicoes))

  return (
    <div className="desp-uso">
      <div className="desp-uso-topo">
        <span className="desp-uso-titulo">Cota do plano grátis</span>
        <span className={`desp-uso-pct ${nivel}`}>{pct}%</span>
      </div>

      <div className="desp-uso-bar">
        <div className={`desp-uso-fill ${nivel}`} style={{ width: `${Math.max(1.5, pct)}%` }} />
      </div>

      <div className="desp-uso-legenda">
        pico de <b>{mil(uso.pico7d)}</b> requisições num dia, de {mil(uso.limite_dia)} por dia
        {' · '}hoje: {mil(uso.hoje)}
      </div>

      {(uso.dias || []).length > 1 && (
        <div className="desp-uso-dias" title="últimos 7 dias">
          {uso.dias.map(d => (
            <span
              key={d.data}
              className="desp-uso-dia"
              style={{ height: `${Math.max(8, (d.requisicoes / maxDia) * 100)}%` }}
              title={`${new Date(d.data + 'T00:00:00').toLocaleDateString('pt-BR')} — ${mil(d.requisicoes)} requisições`}
            />
          ))}
        </div>
      )}

      <div className={`desp-uso-aviso ${nivel}`}>
        {pct >= 80
          ? `Chegando no limite! Passando, vira Workers Paid: US$ ${uso.plano_pago_usd}/mês (≈ ${fmt(uso.plano_pago_usd * USD_BRL)}).`
          : pct >= 50
            ? `Mais da metade da cota. Se passar, vira US$ ${uso.plano_pago_usd}/mês (≈ ${fmt(uso.plano_pago_usd * USD_BRL)}).`
            : `Tranquilo — dá pra crescer ${Math.max(2, Math.floor(100 / Math.max(pct, 1)))}× antes de pagar. Depois do limite: US$ ${uso.plano_pago_usd}/mês (≈ ${fmt(uso.plano_pago_usd * USD_BRL)}).`}
      </div>
    </div>
  )
}

/* ── Um cartão de despesa: leitura limpa, edição só ao clicar no lápis ─────── */
function Despesa({ d, salvar, excluir, editId, setEditId, savingId, setLista }) {
  const cat     = catInfo(d.categoria)
  const editando = editId === d.id
  const semVenc  = d.recorrencia === 'por_uso' || d.recorrencia === 'unico'
  const noMes    = contaNoMes(d)
  const pago     = pagoEsteMes(d)
  const dias     = diasAte(d.data_vencimento)
  const vencida  = !pago && dias !== null && dias < 0

  const editar = patch => setLista(l => l.map(x => x.id === d.id ? { ...x, ...patch } : x))

  let venc = null
  if (pago) {
    venc = { cls: '', txt: <>✓ paga em <b>{dataBR(d.pago_em)}</b></> }
  } else if (d.recorrencia === 'por_uso') {
    venc = { cls: '', txt: 'conforme o uso' }
  } else if (dias === null) {
    venc = { cls: '', txt: 'sem data' }
  } else if (dias < 0) {
    venc = { cls: 'vencida', txt: <>venceu há <b>{Math.abs(dias)} dias</b></> }
  } else if (dias === 0) {
    venc = { cls: 'vencida', txt: <b>vence hoje</b> }
  } else if (dias <= 5) {
    venc = { cls: 'alerta', txt: <>vence {dataBR(d.data_vencimento)} · <b>em {dias}d</b></> }
  } else {
    venc = { cls: '', txt: <>vence {dataBR(d.data_vencimento)} · em {dias}d</> }
  }

  const valorNum = Number(d.valor || 0)
  const temValor = d.valor !== null && d.valor !== '' && valorNum > 0

  return (
    <div
      className={`desp-card${pago ? ' paga' : ''}${vencida ? ' vencida' : ''}${d.ativo ? '' : ' inativa'}`}
      style={{ '--cat': cat.cor, '--cat-bg': cat.cor + '22' }}
    >
      <div className="desp-linha">
        <div className="desp-info">
          <div className="desp-nome">
            {d.nome}
            {!d.ativo && <span className="desp-chip cinza">inativa</span>}
          </div>
          <div className="desp-chips">
            <span className="desp-chip">{cat.label}</span>
            <span className="desp-chip cinza">{recLabel(d.recorrencia)}</span>
            {d.alerta_ativo && !semVenc && (
              <span className="desp-chip cinza">🔔 {d.alerta_dias_antes ?? 3}d antes</span>
            )}
          </div>
          {d.observacoes && <div className="desp-obs" title={d.observacoes}>{d.observacoes}</div>}
          {nomeEhCloudflare(d.nome) && d.ativo && <UsoCloudflare />}
        </div>

        <div>
          <div className={`desp-valor${temValor ? '' : ' vazio'}`}>
            {temValor ? fmt(d.valor, d.moeda || 'BRL')
              : d.recorrencia === 'por_uso' ? 'variável'
              : valorNum === 0 && d.valor !== null ? 'sem custo'
              : 'sem valor'}
          </div>
          <div className={`desp-venc ${venc.cls}`}>{venc.txt}</div>
        </div>

        <div className="desp-acoes">
          {savingId === d.id && <span className="desp-salvando">salvando…</span>}
          {noMes && (
            <button
              className={`desp-pagar${pago ? ' paga' : ''}`}
              onClick={() => salvar(d.id, { pago_em: pago ? null : hojeISO() })}
              title={pago ? 'Clique pra desmarcar' : 'Marcar como paga neste mês'}
            >
              {pago ? '✓ Paga' : 'Marcar paga'}
            </button>
          )}
          <button
            className={`desp-icone${editando ? ' ativo' : ''}`}
            onClick={() => setEditId(editando ? null : d.id)}
            title={editando ? 'Fechar' : 'Editar'}
          >
            {editando ? '✕' : '✏️'}
          </button>
        </div>
      </div>

      {editando && (
        <div className="desp-edit">
          <div className="desp-campo largo">
            <label>Nome do serviço</label>
            <input
              value={d.nome ?? ''}
              onChange={e => editar({ nome: e.target.value })}
              onBlur={e => salvar(d.id, { nome: e.target.value })}
            />
          </div>

          <div className="desp-campo">
            <label>Categoria</label>
            <select value={d.categoria} onChange={e => salvar(d.id, { categoria: e.target.value })}>
              {CATEGORIAS.map(c => <option key={c.valor} value={c.valor}>{c.label}</option>)}
            </select>
          </div>

          <div className="desp-campo">
            <label>Cobrança</label>
            <select value={d.recorrencia} onChange={e => salvar(d.id, { recorrencia: e.target.value })}>
              {RECORRENCIAS.map(r => <option key={r.valor} value={r.valor}>{r.label}</option>)}
            </select>
          </div>

          <div className="desp-campo">
            <label>Valor</label>
            <div className="desp-moeda">
              <select value={d.moeda ?? 'BRL'} onChange={e => salvar(d.id, { moeda: e.target.value })}>
                <option value="BRL">R$</option>
                <option value="USD">US$</option>
              </select>
              <input
                type="number" min="0" step="0.01" placeholder="0,00"
                value={d.valor ?? ''}
                onChange={e => editar({ valor: e.target.value })}
                onBlur={e => salvar(d.id, { valor: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </div>
          </div>

          {!semVenc && (
            <div className="desp-campo">
              <label>Próximo vencimento</label>
              <input
                type="date"
                value={d.data_vencimento ?? ''}
                onChange={e => salvar(d.id, { data_vencimento: e.target.value || null })}
              />
            </div>
          )}

          {!semVenc && (
            <>
              <label className="desp-check">
                <input
                  type="checkbox"
                  checked={!!d.alerta_ativo}
                  onChange={e => salvar(d.id, { alerta_ativo: e.target.checked })}
                />
                🔔 Avisar antes de vencer
              </label>
              {d.alerta_ativo && (
                <div className="desp-campo">
                  <label>Avisar quantos dias antes</label>
                  <input
                    type="number" min="0" max="60"
                    value={d.alerta_dias_antes ?? 3}
                    onChange={e => editar({ alerta_dias_antes: e.target.value })}
                    onBlur={e => salvar(d.id, { alerta_dias_antes: Number(e.target.value || 0) })}
                  />
                </div>
              )}
            </>
          )}

          <div className="desp-campo largo">
            <label>Observação</label>
            <input
              value={d.observacoes ?? ''}
              placeholder="ex: cartão usado, onde pagar, link…"
              onChange={e => editar({ observacoes: e.target.value })}
              onBlur={e => salvar(d.id, { observacoes: e.target.value })}
            />
          </div>

          <div className="desp-edit-rodape">
            <button className="btn btn-secondary btn-sm" onClick={() => salvar(d.id, { ativo: !d.ativo })}>
              {d.ativo ? 'Marcar como inativa' : 'Reativar'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditId(null)}>Fechar</button>
            <button className="desp-excluir" onClick={() => excluir(d.id)}>Excluir despesa</button>
          </div>
        </div>
      )}
    </div>
  )
}
