import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import './ConciliacaoIfood.css'

// Conciliação iFood — aba do Financeiro (migrações 0260 e 0261).
//
// Quatro visões, cada uma com uma API do módulo Financial do iFood, e sempre
// mostrando se ela BATE com as outras (é o que a homologação do iFood cobra e o
// que o dono precisa pra confiar no número):
//   Repasses    — Settlements: quanto cai por semana, em quais títulos, status
//   Vendas      — Sales: pedido a pedido, bruto, taxas e líquido
//   Lançamentos — Financial Events: cada débito e crédito, com impacto no repasse
//   Relatório   — Reconciliation: arquivo mensal oficial (e o sob demanda)
//
// Os dados vêm do banco (a sincronização grava lá). Só "Atualizar agora" e o
// relatório sob demanda falam com o iFood na hora.

const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const fmtSinal = (v) => `${Number(v) < 0 ? '− ' : '+ '}${fmt(Math.abs(Number(v || 0)))}`
const ddmm = (s) => (s ? String(s).slice(0, 10).split('-').reverse().slice(0, 2).join('/') : '—')
const ddmmaa = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—')
const dataHora = (s) => (s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')

const NOME_EVENTO = {
  ORDER_PAYMENT: 'Pagamento do pedido',
  ORDER_COMMISSION: 'Comissão do iFood',
  PAYMENT_TRANSACTION_FEE: 'Taxa de transação',
  SERVICE_FEE: 'Taxa de serviço',
  REFUND_SERVICE_FEE: 'Reembolso da taxa de serviço',
  IFOOD_SUBSIDY: 'Subsídio do iFood',
  STORE_SUBSIDY: 'Promoção da loja',
  MERCHANT_SUBSIDY: 'Promoção da loja',
  DELIVERY_FEE_IFOOD: 'Taxa de entrega iFood',
  DELIVERY_REQUEST: 'Entrega sob demanda',
  STORE_REFUND: 'Reembolso ao cliente',
  COMMISSION_EXEMPTION: 'Isenção de comissão',
}
const GATILHO = {
  ORDER_CONCLUDED: 'pedido concluído',
  ORDER_CANCELLED: 'pedido cancelado',
  SINGLE_OCCURRENCE: 'ocorrência avulsa',
  LOGISTIC_SHIPPING_CHARGE: 'cobrança de entrega',
}
const STATUS_VENDA = { CONCLUDED: 'Concluído', CANCELLED: 'Cancelado', CANCELED: 'Cancelado', DISPATCHED: 'Despachado', CONFIRMED: 'Confirmado', PLACED: 'Recebido' }
const STATUS_TITULO = (s) => {
  const x = String(s || '').toUpperCase()
  if (x === 'SUCCEED') return { txt: 'Pago', cls: 'ok' }
  if (x === 'FAILED') return { txt: 'Falhou', cls: 'erro' }
  if (!x) return { txt: 'Sem status', cls: '' }
  return { txt: x === 'PENDING' || x === 'SCHEDULED' ? 'Programado' : x, cls: 'aviso' }
}

// Meses encerrados dos últimos 24 (o iFood não gera o mês corrente nem arquivo mais velho).
function competencias() {
  const out = []
  const hoje = new Date()
  for (let i = 1; i <= 24; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)
    const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    out.push([v, d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })])
  }
  return out
}

async function chamarFuncao(body) {
  const { data, error } = await supabase.functions.invoke('ifood-integration', { body })
  if (error) throw new Error(error.message)
  if (data && data.ok === false) throw new Error(data.error || 'O iFood não respondeu.')
  return data
}

// O dado exatamente como o iFood mandou. Existe pra PROVAR a origem de cada
// número: no ambiente de teste do iFood os valores não aparecem no Portal do
// Parceiro (são um exemplo fixo), então a prova é mostrar a resposta da API ao
// lado do que a tela exibe. Os campos que viram número na tela vêm em destaque.
function DadoOriginal({ bruto, destaques = [] }) {
  if (!bruto) return <span className="ci-muted">Carregando o dado original…</span>
  const pegar = (obj, caminho) => caminho.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
  return (
    <div className="ci-original">
      <div className="ci-original-titulo">Resposta original do iFood (API Financial)</div>
      {destaques.length > 0 && (
        <div className="ci-original-destaques">
          {destaques.map(([rot, caminho]) => (
            <div key={caminho}><span>{rot}</span><code>{caminho}</code><strong>{JSON.stringify(pegar(bruto, caminho), null, 1) ?? '—'}</strong></div>
          ))}
        </div>
      )}
      <details>
        <summary>Ver JSON completo</summary>
        <pre>{JSON.stringify(bruto, null, 2)}</pre>
      </details>
    </div>
  )
}

function Conferencia({ bate, diferenca, semDados, textoSemDados = 'aguardando lançamentos' }) {
  if (semDados || bate === null || bate === undefined) return <span className="ci-selo">{textoSemDados}</span>
  if (bate) return <span className="ci-selo ok" title="Bate com a soma dos lançamentos que impactam o repasse">✓ bate</span>
  return <span className="ci-selo aviso" title="Não bate com a soma dos lançamentos — confira no iFood">⚠ diferença {diferenca != null ? fmt(Math.abs(diferenca)) : ''}</span>
}

export default function ConciliacaoIfood({ empresaId }) {
  const [aba, setAba] = useState('repasses')
  const [lojas, setLojas] = useState(null)          // linhas de ifood_config
  const [atualizando, setAtualizando] = useState(false)
  const [msg, setMsg] = useState(null)
  const [versao, setVersao] = useState(0)            // sobe quando atualiza, e as visões recarregam

  const carregarLojas = useCallback(async () => {
    if (!empresaId) return
    const { data } = await supabase.from('ifood_config')
      .select('merchant_id, apelido, financeiro_status, financeiro_sync_em, financeiro_erro')
      .eq('empresa_id', empresaId).not('merchant_id', 'is', null)
    setLojas(data ?? [])
  }, [empresaId])
  useEffect(() => { carregarLojas() }, [carregarLojas, versao])

  const nomeLoja = useMemo(() => {
    const m = {}
    ;(lojas ?? []).forEach((l, i) => { m[l.merchant_id] = l.apelido || `Loja ${i + 1}` })
    return m
  }, [lojas])
  const variasLojas = (lojas ?? []).length > 1

  async function atualizarAgora() {
    setAtualizando(true); setMsg(null)
    try {
      const d = await chamarFuncao({ acao: 'financeiro_sync', empresa_id: empresaId })
      const r = d?.resultados ?? []
      if (r.some(x => x.status === 'ok')) {
        const n = r.reduce((s, x) => s + (x.lancamentos || 0), 0)
        const v = r.reduce((s, x) => s + (x.vendas || 0), 0)
        setMsg({ tipo: 'ok', txt: `Atualizado com o iFood: ${n} lançamento${n === 1 ? '' : 's'} e ${v} venda${v === 1 ? '' : 's'} conferidos.` })
      } else if (r.some(x => x.status === 'sem_permissao')) {
        setMsg({ tipo: 'erro', txt: 'O iFood ainda não liberou o módulo financeiro pra sua loja. Assim que liberar, os números aparecem aqui sozinhos.' })
      } else {
        setMsg({ tipo: 'erro', txt: 'O iFood não respondeu agora. Nada foi perdido — tente de novo em alguns minutos.' })
      }
    } catch (e) {
      setMsg({ tipo: 'erro', txt: `Não consegui falar com o iFood: ${e.message}` })
    }
    setVersao(v => v + 1)
    setAtualizando(false)
  }

  if (lojas && lojas.length === 0) {
    return <div className="ci-card"><p className="ci-vazio">Esta loja não tem o iFood conectado. Conecte em Minha Loja → Integração com o iFood.</p></div>
  }

  const status = (() => {
    const ls = lojas ?? []
    const ok = ls.filter(l => l.financeiro_status === 'ok')
    const ultima = ls.map(l => l.financeiro_sync_em).filter(Boolean).sort().pop()
    if (ok.length) return { cls: 'ok', txt: `✓ Sincronizado com o iFood${ultima ? ` · ${dataHora(ultima)}` : ''}${ok.some(l => l.financeiro_erro) ? ` · ${ok.find(l => l.financeiro_erro).financeiro_erro}` : ''}` }
    const erro = ls.find(l => l.financeiro_status === 'erro')
    if (erro) return { cls: 'aviso', txt: `⚠ A última busca no iFood falhou (${dataHora(erro.financeiro_sync_em)}): ${erro.financeiro_erro || 'sem detalhe'}` }
    if (ls.some(l => l.financeiro_status === 'sem_permissao')) return { cls: '', txt: '⏳ O iFood ainda não liberou o módulo financeiro pra sua loja.' }
    return { cls: '', txt: 'Ainda não buscou nada no iFood.' }
  })()

  return (
    <div className="ci">
      <div className="ci-topo">
        <h2>🧾 Conciliação iFood</h2>
        <span className={`ci-topo-status ${status.cls}`}>{status.txt}</span>
        <button type="button" className="ci-btn" onClick={atualizarAgora} disabled={atualizando}>
          {atualizando ? <><span className="ci-giro" />Buscando no iFood…</> : '🔄 Atualizar agora'}
        </button>
      </div>
      {msg && <div className={`ci-msg ${msg.tipo}`}>{msg.txt}</div>}

      <div className="ci-abas">
        {[['repasses', '💸 Repasses'], ['vendas', '🧾 Vendas'], ['lancamentos', '📒 Lançamentos'], ['relatorio', '📄 Relatório mensal']].map(([id, rot]) => (
          <button key={id} type="button" className={`ci-aba${aba === id ? ' ativa' : ''}`} onClick={() => setAba(id)}>{rot}</button>
        ))}
      </div>

      {aba === 'repasses' && <Repasses empresaId={empresaId} versao={versao} nomeLoja={nomeLoja} variasLojas={variasLojas} />}
      {aba === 'vendas' && <Vendas empresaId={empresaId} versao={versao} />}
      {aba === 'lancamentos' && <Lancamentos empresaId={empresaId} versao={versao} />}
      {aba === 'relatorio' && <Relatorio empresaId={empresaId} versao={versao} nomeLoja={nomeLoja} variasLojas={variasLojas} />}
    </div>
  )
}

// ── Repasses (Settlements) ────────────────────────────────────────────────────
function Repasses({ empresaId, versao, nomeLoja, variasLojas }) {
  const [semanas, setSemanas] = useState(null)
  const [titulos, setTitulos] = useState({})
  const [aberta, setAberta] = useState(null)

  useEffect(() => {
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      const [sem, tit] = await Promise.all([
        supabase.from('ifood_liquidacao_semanas').select('*').eq('empresa_id', empresaId)
          .order('semana_ini', { ascending: false }).limit(26),
        fetchAll(() => supabase.from('ifood_liquidacoes').select('*').eq('empresa_id', empresaId)
          .order('semana_ini', { ascending: false }).order('id')),
      ])
      if (!vivo) return
      const porSemana = {}
      for (const t of (tit.data ?? [])) (porSemana[`${t.merchant_id}|${t.semana_ini}`] ??= []).push(t)
      setSemanas(sem.data ?? [])
      setTitulos(porSemana)
    })()
    return () => { vivo = false }
  }, [empresaId, versao])

  if (semanas === null) return <div className="ci-card ci-vazio">Carregando os repasses…</div>

  return (
    <div className="ci-card">
      <h3>Repasses por semana</h3>
      <p className="ci-sub">
        O que o iFood consolida de segunda a domingo e transfere pra você. A coluna <b>Confere</b> compara
        o valor da liquidação com a soma dos lançamentos que impactam o repasse — se não bater, aparece a diferença.
      </p>
      {!semanas.length ? <p className="ci-vazio">Nenhuma liquidação buscada ainda. Clique em “Atualizar agora”.</p> : (
        <div className="ci-tabela-wrap">
          <table className="ci-tabela">
            <thead>
              <tr>
                <th className="esq">Semana</th>
                {variasLojas && <th className="esq">Loja</th>}
                <th>Liquidação (iFood)</th>
                <th>Soma dos lançamentos</th>
                <th>Títulos</th>
                <th>Confere</th>
              </tr>
            </thead>
            <tbody>
              {semanas.map(s => {
                const k = `${s.merchant_id}|${s.semana_ini}`
                const ts = titulos[k] ?? []
                const vazia = Number(s.saldo) === 0 && ts.length === 0 && Number(s.soma_lancamentos || 0) === 0
                return [
                  <tr key={k} className="clicavel" onClick={() => setAberta(aberta === k ? null : k)}>
                    <td className="esq"><b>{aberta === k ? '▾' : '▸'} {ddmm(s.semana_ini)} a {ddmmaa(s.semana_fim)}</b></td>
                    {variasLojas && <td className="esq">{nomeLoja[s.merchant_id] ?? '—'}</td>}
                    <td><b>{fmt(s.saldo)}</b></td>
                    <td>{s.soma_lancamentos != null ? fmt(s.soma_lancamentos) : '—'}</td>
                    <td>{ts.length}</td>
                    <td>{vazia ? <span className="ci-selo">sem movimento</span> : <Conferencia bate={s.conferido} diferenca={s.diferenca} />}</td>
                  </tr>,
                  aberta === k && (
                    <tr key={`${k}-d`}>
                      <td className="ci-detalhe" colSpan={variasLojas ? 6 : 5}>
                        {!ts.length ? <span className="ci-muted">Nenhum título gerado nessa semana.</span> : (
                          <table className="ci-tabela">
                            <thead><tr><th className="esq">Título</th><th className="esq">Status</th><th>Pagamento</th><th>Valor</th><th className="esq">Conta de destino</th></tr></thead>
                            <tbody>
                              {ts.map(t => {
                                const st = STATUS_TITULO(t.status)
                                return (
                                  <tr key={t.id}>
                                    <td className="esq">{t.tipo || '—'}<span className="pequeno">{ddmm(t.periodo_ini)} a {ddmm(t.periodo_fim)}</span></td>
                                    <td className="esq"><span className={`ci-selo ${st.cls}`}>{st.txt}</span></td>
                                    <td>{ddmmaa(t.data_pagamento)}</td>
                                    <td><b>{fmt(t.valor)}</b></td>
                                    <td className="esq" style={{ whiteSpace: 'normal' }}>
                                      {t.dados_bancarios
                                        ? Object.entries(t.dados_bancarios).map(([c, v]) => <span key={c} className="pequeno">{c}: {String(v)}</span>)
                                        : <span className="ci-muted">{st.cls === 'ok' ? 'não informado pelo iFood' : 'aparece quando for pago'}</span>}
                                    </td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Vendas (Sales) ────────────────────────────────────────────────────────────
const VENDAS_PAGINA = 50

function Vendas({ empresaId, versao }) {
  const [dias, setDias] = useState(14)
  const [busca, setBusca] = useState('')
  const [vendas, setVendas] = useState(null)
  const [mostrar, setMostrar] = useState(VENDAS_PAGINA)
  const [aberta, setAberta] = useState(null)       // venda_id com o original aberto
  const [originais, setOriginais] = useState({})   // venda_id -> bruto (carrega sob demanda: é pesado)

  async function abrirOriginal(vendaId) {
    if (aberta === vendaId) { setAberta(null); return }
    setAberta(vendaId)
    if (originais[vendaId]) return
    const { data } = await supabase.from('ifood_vendas').select('bruto')
      .eq('empresa_id', empresaId).eq('venda_id', vendaId).maybeSingle()
    setOriginais(o => ({ ...o, [vendaId]: data?.bruto ?? { erro: 'sem dado original' } }))
  }

  useEffect(() => {
    if (!empresaId) return
    let vivo = true
    setVendas(null); setMostrar(VENDAS_PAGINA)
    fetchAll(() => {
      let q = supabase.from('ifood_vendas')
        .select('venda_id, numero_curto, criado_em, status, metodos, valor_itens, taxa_entrega, beneficios, comissoes_taxas, saldo, conferido, soma_lancamentos')
        .eq('empresa_id', empresaId)
      // 0 = tudo que já foi sincronizado (o histórico cresce a cada dia).
      if (dias > 0) q = q.gte('criado_em', new Date(Date.now() - dias * 86400000).toISOString())
      return q.order('criado_em', { ascending: false }).order('venda_id')
    })
      .then(({ data }) => { if (vivo) setVendas(data ?? []) })
    return () => { vivo = false }
  }, [empresaId, dias, versao])

  const lista = useMemo(() => {
    const q = busca.trim().toLowerCase()
    return (vendas ?? []).filter(v => !q || String(v.numero_curto ?? '').includes(q) || String(v.venda_id).toLowerCase().includes(q))
  }, [vendas, busca])

  const tot = lista.reduce((a, v) => ({
    bruto: a.bruto + Number(v.valor_itens || 0) + Number(v.taxa_entrega || 0),
    ben: a.ben + Number(v.beneficios || 0),
    taxas: a.taxas + Number(v.comissoes_taxas || 0),
    liq: a.liq + Number(v.saldo || 0),
  }), { bruto: 0, ben: 0, taxas: 0, liq: 0 })
  const divergentes = lista.filter(v => v.conferido === false).length

  return (
    <div className="ci-card">
      <h3>Vendas no iFood</h3>
      <p className="ci-sub">
        Cada pedido com o valor bruto, o que o iFood cobrou e o <b>líquido</b> que ele calcula pra você. A coluna
        <b> Confere</b> compara o líquido com a soma dos lançamentos daquele pedido.
      </p>
      <div className="ci-filtros">
        <select value={dias} onChange={e => setDias(Number(e.target.value))}>
          {[7, 14, 30, 90].map(d => <option key={d} value={d}>Últimos {d} dias</option>)}
          <option value={0}>Todo o histórico</option>
        </select>
        <input type="search" placeholder="Buscar nº do pedido" value={busca} onChange={e => setBusca(e.target.value)} />
        {divergentes > 0 && <span className="ci-selo aviso">⚠ {divergentes} pedido{divergentes === 1 ? '' : 's'} com diferença</span>}
      </div>
      {vendas === null ? <p className="ci-vazio">Carregando as vendas…</p> : !lista.length ? <p className="ci-vazio">Nenhuma venda nesse período.</p> : (
        <>
          <div className="ci-tabela-wrap">
            <table className="ci-tabela">
              <thead>
                <tr>
                  <th className="esq">Pedido</th>
                  <th className="esq">Status</th>
                  <th className="esq">Pagamento</th>
                  <th>Bruto</th>
                  <th title="Desconto bancado pelo iFood">Benefícios</th>
                  <th>Comissões e taxas</th>
                  <th>Líquido</th>
                  <th>Confere</th>
                </tr>
              </thead>
              <tbody>
                {lista.slice(0, mostrar).map(v => [
                  <tr key={v.venda_id} className="clicavel" onClick={() => abrirOriginal(v.venda_id)} title="Clique pra ver o dado original do iFood">
                    <td className="esq"><b>{aberta === v.venda_id ? '▾' : '▸'} #{v.numero_curto || String(v.venda_id).slice(-6)}</b><span className="pequeno">{dataHora(v.criado_em)}</span></td>
                    <td className="esq">{STATUS_VENDA[v.status] ?? v.status ?? '—'}</td>
                    <td className="esq" style={{ whiteSpace: 'normal', minWidth: 120 }}>{v.metodos || '—'}</td>
                    <td>{fmt(Number(v.valor_itens || 0) + Number(v.taxa_entrega || 0))}</td>
                    <td className={Number(v.beneficios) > 0 ? 'ci-pos' : 'ci-muted'}>{Number(v.beneficios) > 0 ? fmt(v.beneficios) : '—'}</td>
                    <td className="ci-neg">{Number(v.comissoes_taxas) > 0 ? `− ${fmt(v.comissoes_taxas)}` : '—'}</td>
                    <td><b>{v.saldo != null ? fmt(v.saldo) : '—'}</b></td>
                    <td><Conferencia bate={v.conferido} diferenca={v.soma_lancamentos != null && v.saldo != null ? v.saldo - v.soma_lancamentos : null} /></td>
                  </tr>,
                  aberta === v.venda_id && (
                    <tr key={`${v.venda_id}-o`}>
                      <td className="ci-detalhe" colSpan={8}>
                        <DadoOriginal bruto={originais[v.venda_id]} destaques={[
                          ['Pedido', 'shortId'], ['Status', 'currentStatus'],
                          ['Itens (bruto)', 'saleGrossValue.bag'], ['Taxa de entrega', 'saleGrossValue.deliveryFee'],
                          ['Benefícios', 'benefits.totalValue'], ['Pagamentos', 'payments.methods'],
                          ['Taxas e comissões', 'billingSummary.billingEntries'], ['Líquido', 'billingSummary.saleBalance'],
                        ]} />
                      </td>
                    </tr>
                  ),
                ])}
              </tbody>
              <tfoot>
                <tr>
                  <td className="esq" colSpan={3}>{lista.length} pedido{lista.length === 1 ? '' : 's'}</td>
                  <td>{fmt(tot.bruto)}</td>
                  <td className="ci-pos">{fmt(tot.ben)}</td>
                  <td className="ci-neg">− {fmt(tot.taxas)}</td>
                  <td>{fmt(tot.liq)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {lista.length > mostrar && (
            <button type="button" className="ci-btn" style={{ marginTop: 10 }} onClick={() => setMostrar(m => m + VENDAS_PAGINA)}>
              Mostrar mais ({lista.length - mostrar})
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Lançamentos (Financial Events) ────────────────────────────────────────────
const LANC_PAGINA = 100

function Lancamentos({ empresaId, versao }) {
  const [periodos, setPeriodos] = useState(null)
  const [periodo, setPeriodo] = useState('')
  const [soImpacto, setSoImpacto] = useState(false)
  const [itens, setItens] = useState(null)
  const [mostrar, setMostrar] = useState(LANC_PAGINA)
  const [aberto, setAberto] = useState(null)

  useEffect(() => {
    if (!empresaId) return
    supabase.from('ifood_repasse_semanal').select('periodo_ini, periodo_fim, previsao_pagamento')
      .eq('empresa_id', empresaId).eq('fonte', 'api').order('periodo_ini', { ascending: false }).limit(26)
      .then(({ data }) => {
        const ps = data ?? []
        setPeriodos(ps)
        setPeriodo(p => p || ps[0]?.periodo_ini || '')
      })
  }, [empresaId, versao])

  useEffect(() => {
    if (!empresaId || !periodo) { setItens([]); return }
    let vivo = true
    setItens(null); setMostrar(LANC_PAGINA)
    fetchAll(() => supabase.from('ifood_eventos_financeiros')
      .select('id, nome, descricao, gatilho, referencia_tipo, referencia_id, referencia_em, valor, impacta_repasse, previsao_pagamento, metodo_pagamento, responsavel, percentual, bruto')
      .eq('empresa_id', empresaId).eq('periodo_ini', periodo)
      .order('referencia_em', { ascending: false, nullsFirst: false }).order('id'))
      .then(({ data }) => { if (vivo) setItens(data ?? []) })
    return () => { vivo = false }
  }, [empresaId, periodo, versao])

  const lista = (itens ?? []).filter(e => !soImpacto || e.impacta_repasse)
  const pendente = (e) => String(e.bruto?.status ?? '').toUpperCase() === 'PENDING'
  const somaImpacto = (itens ?? []).filter(e => e.impacta_repasse && !pendente(e)).reduce((s, e) => s + Number(e.valor), 0)
  const creditos = lista.filter(e => Number(e.valor) > 0).reduce((s, e) => s + Number(e.valor), 0)
  const debitos = lista.filter(e => Number(e.valor) < 0).reduce((s, e) => s + Number(e.valor), 0)

  return (
    <div className="ci-card">
      <h3>Lançamentos financeiros</h3>
      <p className="ci-sub">
        Cada crédito e débito que o iFood registrou, no período de apuração. Só os marcados com <b>impacto no repasse</b>
        entram no valor transferido; os outros são informativos (ex.: pagamento recebido direto na loja).
      </p>
      <div className="ci-filtros">
        <select value={periodo} onChange={e => setPeriodo(e.target.value)} disabled={!periodos?.length}>
          {!periodos?.length && <option value="">Sem períodos ainda</option>}
          {(periodos ?? []).map(p => (
            <option key={p.periodo_ini} value={p.periodo_ini}>
              {ddmm(p.periodo_ini)} a {ddmmaa(p.periodo_fim)}{p.previsao_pagamento ? ` · repasse ${ddmm(p.previsao_pagamento)}` : ''}
            </option>
          ))}
        </select>
        <label><input type="checkbox" checked={soImpacto} onChange={e => setSoImpacto(e.target.checked)} /> Só com impacto no repasse</label>
      </div>
      {itens === null ? <p className="ci-vazio">Carregando os lançamentos…</p> : !lista.length ? <p className="ci-vazio">Nenhum lançamento nesse período.</p> : (
        <>
          <div className="ci-tabela-wrap">
            <table className="ci-tabela">
              <thead>
                <tr>
                  <th className="esq">Data</th>
                  <th className="esq">Tipo</th>
                  <th className="esq">Gatilho</th>
                  <th className="esq">Pedido</th>
                  <th>Valor</th>
                  <th>Repasse previsto</th>
                  <th>Impacta repasse</th>
                </tr>
              </thead>
              <tbody>
                {lista.slice(0, mostrar).map(e => [
                  <tr key={e.id} className="clicavel" onClick={() => setAberto(aberto === e.id ? null : e.id)} title="Clique pra ver o dado original do iFood">
                    <td className="esq">{aberto === e.id ? '▾ ' : '▸ '}{e.referencia_em ? dataHora(e.referencia_em) : '—'}</td>
                    <td className="esq">
                      {NOME_EVENTO[e.nome] ?? e.nome}
                      <span className="pequeno">{e.nome}{e.percentual != null ? ` · ${e.percentual}%` : ''}{e.metodo_pagamento ? ` · ${e.metodo_pagamento}` : ''}{pendente(e) ? ' · PENDENTE' : ''}</span>
                    </td>
                    <td className="esq">{GATILHO[e.gatilho] ?? e.gatilho ?? '—'}</td>
                    <td className="esq">{e.referencia_tipo === 'ORDER' && e.referencia_id ? `…${String(e.referencia_id).slice(-6)}` : '—'}</td>
                    <td className={Number(e.valor) < 0 ? 'ci-neg' : 'ci-pos'}><b>{fmtSinal(e.valor)}</b></td>
                    <td>{ddmmaa(e.previsao_pagamento)}</td>
                    <td>{e.impacta_repasse ? <span className="ci-selo ok">Sim</span> : <span className="ci-selo">Não</span>}</td>
                  </tr>,
                  aberto === e.id && (
                    <tr key={`${e.id}-o`}>
                      <td className="ci-detalhe" colSpan={7}>
                        <DadoOriginal bruto={e.bruto} destaques={[
                          ['Tipo', 'name'], ['Gatilho', 'trigger'], ['Valor', 'amount.value'],
                          ['Impacta repasse', 'hasTransferImpact'], ['Período', 'period'],
                          ['Repasse previsto', 'settlement.expectedDate'], ['Pedido', 'reference.id'],
                        ]} />
                      </td>
                    </tr>
                  ),
                ])}
              </tbody>
              <tfoot>
                <tr>
                  <td className="esq" colSpan={4}>{lista.length} lançamento{lista.length === 1 ? '' : 's'} · créditos {fmt(creditos)} · débitos {fmt(Math.abs(debitos))}</td>
                  <td colSpan={3}>Soma com impacto no repasse: <span className={somaImpacto < 0 ? 'ci-neg' : 'ci-pos'}>{fmt(somaImpacto)}</span></td>
                </tr>
              </tfoot>
            </table>
          </div>
          {lista.length > mostrar && (
            <button type="button" className="ci-btn" style={{ marginTop: 10 }} onClick={() => setMostrar(m => m + LANC_PAGINA)}>
              Mostrar mais ({lista.length - mostrar})
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Relatório mensal (Reconciliation + On-Demand) ─────────────────────────────
function Relatorio({ empresaId, versao, nomeLoja, variasLojas }) {
  const opcoes = useMemo(competencias, [])
  const [comp, setComp] = useState(opcoes[0][0])
  const [linhas, setLinhas] = useState(null)
  const [ocupado, setOcupado] = useState(null)       // 'mensal' | 'solicitar' | 'baixar:<id>'
  const [msg, setMsg] = useState(null)
  const [acompanhando, setAcompanhando] = useState(false)
  const timer = useRef(null)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    const { data } = await supabase.from('ifood_conciliacao_mensal').select('*')
      .eq('empresa_id', empresaId).eq('competencia', comp)
    setLinhas(data ?? [])
    return data ?? []
  }, [empresaId, comp])

  useEffect(() => { setLinhas(null); setMsg(null); carregar() }, [carregar, versao])
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => { clearTimeout(timer.current); setAcompanhando(false) }, [comp])

  const mensais = (linhas ?? []).filter(l => l.origem === 'mensal')
  const sobDemanda = (linhas ?? []).filter(l => l.origem === 'sob_demanda')
  const rotuloComp = opcoes.find(o => o[0] === comp)?.[1] ?? comp

  async function buscarMensal() {
    setOcupado('mensal'); setMsg(null)
    try {
      const d = await chamarFuncao({ acao: 'conciliacao_mensal', empresa_id: empresaId, competencia: comp })
      const r = d.resultados ?? []
      const erro = r.find(x => x.status !== 'pronto')
      setMsg(erro ? { tipo: 'erro', txt: erro.erro || 'O iFood não entregou o arquivo.' } : { tipo: 'ok', txt: `Arquivo de ${rotuloComp} atualizado.` })
    } catch (e) { setMsg({ tipo: 'erro', txt: e.message }) }
    await carregar()
    setOcupado(null)
  }

  // Acompanha o pedido sob demanda com espera crescente (2s, 4s, 8s… até 30s),
  // parando quando fica pronto, dá erro ou passam ~10 minutos.
  function acompanhar(tentativa = 0) {
    clearTimeout(timer.current)
    if (tentativa > 20) { setAcompanhando(false); return }
    setAcompanhando(true)
    const espera = Math.min(30000, 2000 * 2 ** tentativa)
    timer.current = setTimeout(async () => {
      try {
        const d = await chamarFuncao({ acao: 'conciliacao_status', empresa_id: empresaId, competencia: comp })
        const st = (d.resultados ?? []).map(x => x.status)
        await carregar()
        if (st.length && st.every(s => s === 'pronto' || s === 'erro' || s === 'nao_solicitado' || s === 'sem_permissao')) {
          setAcompanhando(false)
          return
        }
      } catch { /* tenta de novo na próxima volta */ }
      acompanhar(tentativa + 1)
    }, espera)
  }

  async function solicitar() {
    setOcupado('solicitar'); setMsg(null)
    try {
      const d = await chamarFuncao({ acao: 'conciliacao_solicitar', empresa_id: empresaId, competencia: comp })
      const r = d.resultados ?? []
      const erro = r.find(x => x.status === 'erro' || x.status === 'sem_permissao')
      if (erro) setMsg({ tipo: 'erro', txt: erro.erro })
      else {
        setMsg({
          tipo: 'ok',
          txt: r.some(x => x.reaproveitado)
            ? `Já havia um pedido recente do relatório de ${rotuloComp} no iFood — acompanhando esse mesmo.`
            : `Relatório de ${rotuloComp} pedido ao iFood. Ele é gerado em segundo plano; esta tela acompanha sozinha.`,
        })
        acompanhar(0)
      }
    } catch (e) { setMsg({ tipo: 'erro', txt: e.message }) }
    await carregar()
    setOcupado(null)
  }

  async function baixar(l) {
    setOcupado(`baixar:${l.id}`)
    try {
      const { data, error } = await supabase.storage.from('ifood-conciliacao').createSignedUrl(l.arquivo_path, 300, {
        download: `ifood-conciliacao-${l.competencia}${variasLojas ? `-${(nomeLoja[l.merchant_id] || 'loja').replace(/\s+/g, '-')}` : ''}.csv`,
      })
      if (error) throw new Error(error.message)
      window.location.assign(data.signedUrl)
    } catch (e) {
      setMsg({ tipo: 'erro', txt: `Não consegui baixar o arquivo: ${e.message}` })
    }
    setOcupado(null)
  }

  const Passos = ({ status }) => {
    const ordem = ['solicitado', 'processando', 'pronto']
    const idx = ordem.indexOf(status)
    return (
      <div className="ci-passos">
        {ordem.map((p, i) => {
          const cls = status === 'erro' && i === Math.max(idx, 1) ? 'falhou' : i < idx || status === 'pronto' ? 'feito' : i === idx ? 'atual' : ''
          return <span key={p} className={`ci-passo ${cls}`}>{i + 1}. {p === 'solicitado' ? 'Pedido' : p === 'processando' ? 'Gerando' : 'Pronto'}</span>
        })}
        {status === 'erro' && <span className="ci-passo falhou">Falhou</span>}
      </div>
    )
  }

  const Resumo = ({ l }) => {
    const r = l.resumo || {}
    const itens = [
      ['Vendas', r.vendas], ['Recebido direto na loja', r.recebido_na_loja],
      [`Cancelamentos${r.pedidos_cancelados ? ` (${r.pedidos_cancelados} pedidos)` : ''}`, r.cancelamentos],
      ['Comissões e taxas', r.comissoes_taxas], ['Subsídios do iFood', r.subsidios_ifood], ['Promoções da loja', r.promocoes_loja],
      ['Anúncios', r.anuncios], ['Entregas sob demanda', r.entregas], ['Mensalidade', r.mensalidade],
    ].filter(([, v]) => v != null && Number(v) !== 0)
    return (
      <>
        {/* Arquivo de outro mês ou de outra loja: os números abaixo NÃO são desta
            conciliação. Fica escrito em cima, antes de qualquer valor. */}
        {Array.isArray(r.alertas) && r.alertas.length > 0 && (
          <div className="ci-msg erro" style={{ marginTop: 10 }}>
            ⚠ <b>Este arquivo não confere com o que foi pedido:</b> {r.alertas.join(' ')} Os valores abaixo não são desta loja neste mês.
          </div>
        )}
        <div className="ci-resumo">
          {itens.map(([rot, v]) => (
            <div key={rot}><span>{rot}</span><strong className={Number(v) < 0 ? 'ci-neg' : ''}>{fmt(v)}</strong></div>
          ))}
          <div className="destaque"><span>Líquido do repasse (impacto no repasse = SIM)</span><strong className="ci-pos">{fmt(r.repasse_arquivo)}</strong></div>
        </div>
        <div className="ci-filtros">
          <span className="ci-muted" style={{ fontSize: 12 }}>
            Conferência com os lançamentos do mês ({l.soma_lancamentos != null ? fmt(l.soma_lancamentos) : 'sem lançamentos'}):
          </span>
          <Conferencia bate={l.conferido} semDados={l.soma_lancamentos == null}
            diferenca={l.soma_lancamentos != null ? Number(r.repasse_arquivo) - Number(l.soma_lancamentos) : null}
            textoSemDados="sem lançamentos do mês pra comparar" />
        </div>
        {Array.isArray(r.titulos) && r.titulos.length > 0 && (
          <div className="ci-tabela-wrap">
            <table className="ci-tabela">
              <thead><tr><th className="esq">Título de repasse</th><th>Recebimento esperado</th><th>Valor</th></tr></thead>
              <tbody>
                {r.titulos.map(t => (
                  <tr key={t.titulo}><td className="esq">{t.titulo}</td><td>{ddmmaa(t.data_repasse)}</td><td><b>{fmt(t.valor)}</b></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {Array.isArray(r.categorias) && r.categorias.length > 0 && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>Lançamentos do arquivo por categoria ({r.categorias.length})</summary>
            <div className="ci-tabela-wrap">
              <table className="ci-tabela">
                <thead><tr><th className="esq">Fato gerador</th><th className="esq">Tipo</th><th className="esq">Descrição</th><th>Impacto</th><th>Qtd</th><th>Valor</th></tr></thead>
                <tbody>
                  {r.categorias.map((c, i) => (
                    <tr key={i}>
                      <td className="esq">{c.fato}</td><td className="esq">{c.tipo}</td><td className="esq">{c.descricao}</td>
                      <td>{c.impacto}</td><td>{c.qtd}</td>
                      <td className={Number(c.valor) < 0 ? 'ci-neg' : 'ci-pos'}>{fmtSinal(c.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </>
    )
  }

  return (
    <div className="ci-card">
      <h3>Relatório mensal do iFood</h3>
      <p className="ci-sub">
        O arquivo oficial de conciliação do mês, com todos os lançamentos — é o que vale pra contabilidade.
        Só existe pra meses já encerrados (até 24 meses atrás).
      </p>
      <div className="ci-filtros">
        <select value={comp} onChange={e => setComp(e.target.value)}>
          {opcoes.map(([v, rot]) => <option key={v} value={v}>{rot}</option>)}
        </select>
        <button type="button" className="ci-btn" onClick={buscarMensal} disabled={!!ocupado}>
          {ocupado === 'mensal' ? <><span className="ci-giro" />Buscando…</> : '📥 Buscar arquivo do mês'}
        </button>
        <button type="button" className="ci-btn" onClick={solicitar} disabled={!!ocupado || acompanhando}>
          {ocupado === 'solicitar' ? <><span className="ci-giro" />Pedindo…</> : acompanhando ? <><span className="ci-giro" />Acompanhando o pedido…</> : '🧾 Gerar relatório sob demanda'}
        </button>
      </div>
      {msg && <div className={`ci-msg ${msg.tipo}`} style={{ marginBottom: 10 }}>{msg.txt}</div>}

      {linhas === null ? <p className="ci-vazio">Carregando…</p> : (
        <>
          {!mensais.length && !sobDemanda.length && (
            <p className="ci-vazio">Nada buscado para {rotuloComp} ainda. Use um dos botões acima.</p>
          )}

          {mensais.map(l => (
            <div key={l.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 6 }}>
              <div className="ci-filtros" style={{ marginBottom: 0 }}>
                <b style={{ fontSize: 13 }}>Arquivo mensal{variasLojas ? ` · ${nomeLoja[l.merchant_id] ?? ''}` : ''}</b>
                {l.status === 'pronto'
                  ? <span className="ci-selo ok">✓ pronto · {l.linhas} linhas · {dataHora(l.atualizado_em)}</span>
                  : <span className="ci-selo erro">⚠ {l.erro || 'não disponível'}</span>}
                {l.status === 'pronto' && l.arquivo_path && (
                  <button type="button" className="ci-btn cheio" onClick={() => baixar(l)} disabled={!!ocupado}>
                    {ocupado === `baixar:${l.id}` ? 'Gerando link…' : '⬇ Baixar CSV'}
                  </button>
                )}
              </div>
              {l.status === 'pronto' && <Resumo l={l} />}
            </div>
          ))}

          {sobDemanda.map(l => (
            <div key={l.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
              <div className="ci-filtros" style={{ marginBottom: 0 }}>
                <b style={{ fontSize: 13 }}>Relatório sob demanda{variasLojas ? ` · ${nomeLoja[l.merchant_id] ?? ''}` : ''}</b>
                <span className="ci-muted" style={{ fontSize: 11.5 }}>pedido {l.request_id ? `…${String(l.request_id).slice(-8)}` : ''} · atualizado {dataHora(l.atualizado_em)}</span>
                {l.status === 'pronto' && l.arquivo_path && (
                  <button type="button" className="ci-btn cheio" onClick={() => baixar(l)} disabled={!!ocupado}>
                    {ocupado === `baixar:${l.id}` ? 'Gerando link…' : '⬇ Baixar CSV'}
                  </button>
                )}
                {(l.status === 'solicitado' || l.status === 'processando') && !acompanhando && (
                  <button type="button" className="ci-btn" onClick={() => acompanhar(0)}>Verificar agora</button>
                )}
              </div>
              <Passos status={l.status} />
              {l.status === 'erro' && <div className="ci-msg erro">{l.erro}</div>}
              {l.status === 'pronto' && <Resumo l={l} />}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
