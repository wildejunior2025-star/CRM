import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { hojeBR } from '../lib/feriados'
import { faseDaMensalidade, dataCurtaBR, somaDiasYmd } from '../lib/mensalidade'
import '../components/Page.css'

const STATUS_LABELS = {
  trial: 'Trial',
  ativo: 'Ativo',
  atrasado: 'Atrasado',
  suspenso: 'Suspenso',
  cancelado: 'Cancelado',
}

const STATUS_BADGES = {
  trial: 'badge-primary',
  ativo: 'badge-success',
  atrasado: 'badge-warning',
  suspenso: 'badge-danger',
  cancelado: 'badge-neutral',
}

function fmt(val) {
  return Number(val).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// Medidor de capacidade — limite/alerta de cada gargalo conhecido.
// Ajuste os números conforme for aumentando a infraestrutura (Railway, IA, Supabase).
const CAP_METRICAS = [
  { key: 'bot_conversas_ativas', label: 'Conversas no bot', sub: 'atendimentos nos últimos 10 min', limite: 10,   alerta: 6,    unidade: '',     limiteLabel: '10' },
  { key: 'ia_por_minuto',        label: 'IA por minuto',    sub: 'respostas do bot no último minuto', limite: 50, alerta: 35,   unidade: '',     limiteLabel: '50/min' },
  { key: 'lojas_bot_ativo',      label: 'Lojas com bot',    sub: 'lojas com robô ligado (IA ou link)',          limite: 15, alerta: 10,   unidade: '',     limiteLabel: '15' },
  { key: 'banco_mb',             label: 'Banco de dados',   sub: 'espaço usado (8 GB inclusos)',      limite: 8192, alerta: 6000, unidade: ' MB', limiteLabel: '8 GB' },
]

function Card({ titulo, valor, sub, cor, onClick }) {
  return (
    <div className="card" onClick={onClick} style={{ padding: '18px 22px', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>{titulo}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: cor ?? 'var(--text)' }}>{valor}</div>
      <div style={{ fontSize: 11, color: onClick ? 'var(--primary)' : 'var(--text-muted)', marginTop: 2 }}>{sub}</div>
    </div>
  )
}

export default function SuperAdminDashboard() {
  const [empresas, setEmpresas] = useState([])
  const [pedidosMes, setPedidosMes] = useState([])
  const [comissaoCfg, setComissaoCfg] = useState({})
  // Mensalidade semanal (mig 0263): o Dashboard lia o valor_mensalidade antigo
  // e mostrava MRR de R$ 399 com R$ 412,50 entrando por SEMANA (13/09).
  const [mensCfg, setMensCfg] = useState([])
  const [mensCob, setMensCob] = useState([])
  const [loading, setLoading] = useState(true)
  const [refToken, setRefToken] = useState(null)
  const [copiado, setCopiado] = useState(false)
  const [cap, setCap] = useState(null)
  const timerRef = useRef(null)
  const navigate = useNavigate()

  // ── Medidor de capacidade — atualiza a cada 30s ──
  useEffect(() => {
    let vivo = true
    async function carregarCap() {
      const { data, error } = await supabase.rpc('capacidade_sistema')
      if (vivo && !error) setCap(data)
    }
    carregarCap()
    const id = setInterval(carregarCap, 30_000)
    return () => { vivo = false; clearInterval(id) }
  }, [])

  useEffect(() => {
    const inicioMes = new Date()
    inicioMes.setDate(1)
    inicioMes.setHours(0, 0, 0, 0)

    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) supabase.from('profiles').select('ref_token').eq('id', user.id).single()
        .then(({ data }) => { if (data?.ref_token) setRefToken(data.ref_token) })
    })

    const hojeYmd = hojeBR()
    Promise.all([
      supabase.from('empresas').select('*').order('nome'),
      // Paginado: no mês passa de mil pedidos, e a consulta simples cortava em mil.
      fetchAll(() => supabase
        .from('pedidos_delivery')
        .select('origem, total, status')
        .gte('created_at', inicioMes.toISOString())
        .neq('status', 'cancelado')),
      supabase
        .from('configuracoes_plataforma')
        .select('chave, valor')
        .in('chave', ['comissao_vendas_pct', 'comissao_vendas_ativo']),
      supabase.rpc('mensalidade_atualizar_todas').then(() => supabase.from('mensalidade_config').select('*').eq('ativa', true)),
      supabase.from('mensalidade_cobrancas').select('empresa_id, vencimento, referencia, valor, valor_pago, status, pago_em')
        .gte('vencimento', somaDiasYmd(hojeYmd, -120)).order('vencimento'),
    ]).then(([{ data: emp }, { data: ped }, { data: cfg }, { data: mcfg }, { data: mcob }]) => {
      setEmpresas(emp ?? [])
      setPedidosMes(ped ?? [])
      setMensCfg(mcfg ?? [])
      setMensCob(mcob ?? [])
      const cfgMap = {}
      for (const c of cfg ?? []) cfgMap[c.chave] = c.valor
      setComissaoCfg(cfgMap)
      setLoading(false)
    })
  }, [])

  if (loading) return <div className="page-loading">Carregando...</div>


  const ativas    = empresas.filter(e => e.status === 'ativo')
  const trial     = empresas.filter(e => e.status === 'trial')
  const suspensas = empresas.filter(e => e.status === 'suspenso')

  // ── Mensalidade semanal ────────────────────────────────────────────────────
  const hojeYmd = hojeBR()
  const cfgPorLoja = Object.fromEntries(mensCfg.map(c => [c.empresa_id, c]))
  const porSemana = mensCfg.reduce((s, c) => s + (c.periodicidade === 'semanal' ? Number(c.valor) : Number(c.valor) * 12 / 52), 0)
  const mrr = porSemana * 52 / 12
  const mensDe = (emp) => {
    const cfg = cfgPorLoja[emp.id]
    if (!cfg) return null
    const vencidas = mensCob.filter(c => c.empresa_id === emp.id && c.status === 'aberta' && c.vencimento <= hojeYmd)
    const estado = faseDaMensalidade({
      ativa: true, hoje: hojeYmd, mais_antiga_vencida: vencidas[0]?.vencimento ?? null,
      carencia_dias: cfg.carencia_dias, prazo_ate: cfg.prazo_ate, liberado_ate: null,
    }, { grade: emp.horarios_funcionamento, excecoes: {}, fechaFeriado: !!emp.feriados_fecha })
    return { cfg, estado, emAberto: vencidas.reduce((s, c) => s + Number(c.valor), 0) }
  }
  const mensLojas = empresas.map(e => ({ e, m: mensDe(e) })).filter(x => x.m)
  const emAtraso = mensLojas.filter(x => ['carencia', 'prazo'].includes(x.m.estado.fase))
  const bloqueadas = mensLojas.filter(x => x.m.estado.fase === 'bloqueio')
  const totalEmAberto = mensLojas.reduce((s, x) => s + x.m.emAberto, 0)
  const inicioMesYmd = hojeYmd.slice(0, 8) + '01'
  const recebidoMes = mensCob
    .filter(c => c.status === 'paga' && c.pago_em && new Date(c.pago_em).toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' }) >= inicioMesYmd)
    .reduce((s, c) => s + Number(c.valor_pago ?? c.valor), 0)
  const nomeLoja = id => empresas.find(e => e.id === id)?.nome ?? '—'
  const vencendo = mensCob.filter(c => c.status === 'aberta' && c.vencimento >= hojeYmd && c.vencimento <= somaDiasYmd(hojeYmd, 7))

  const comissaoPct   = Number(comissaoCfg.comissao_vendas_pct ?? 0)
  const comissaoAtiva = comissaoCfg.comissao_vendas_ativo !== 'false'

  const gmvMes     = pedidosMes.reduce((s, p) => s + Number(p.total ?? 0), 0)
  const pedidosWA  = pedidosMes.filter(p => p.origem === 'whatsapp')
  const pedidosApp = pedidosMes.filter(p => p.origem === 'app')
  const pedidosCar = pedidosMes.filter(p => !p.origem || p.origem === 'cardapio')
  const gmvWA      = pedidosWA.reduce((s, p) => s + Number(p.total ?? 0), 0)
  const gmvApp     = pedidosApp.reduce((s, p) => s + Number(p.total ?? 0), 0)
  const gmvCar     = pedidosCar.reduce((s, p) => s + Number(p.total ?? 0), 0)
  const comissaoMes = comissaoAtiva ? gmvApp * comissaoPct / 100 : 0

  const semCreditoWA = empresas.filter(
    e => ['ativo', 'trial'].includes(e.status) && (e.whatsapp_creditos ?? 0) === 0
  )

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
      </div>

      {/* Alerta WA zerado */}
      {semCreditoWA.length > 0 && (
        <div style={{
          marginBottom: 20,
          padding: '12px 16px',
          borderRadius: 10,
          background: 'rgba(239,68,68,.1)',
          border: '1px solid rgba(239,68,68,.35)',
          color: 'var(--danger)',
          fontSize: 14,
          lineHeight: 1.5,
        }}>
          <strong>⚠️ {semCreditoWA.length} loja{semCreditoWA.length !== 1 ? 's' : ''} com créditos WhatsApp zerados</strong>
          <br />
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            {semCreditoWA.map(e => e.nome).join(' · ')}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => navigate('/super-admin/empresas')}
            style={{ marginLeft: 12, verticalAlign: 'middle' }}
          >
            Gerenciar →
          </button>
        </div>
      )}

      {/* Cards principais — mensalidade semanal (mig 0263) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 24 }}>
        <Card titulo="Receita por mês" valor={fmt(mrr)} cor="var(--primary)"
          sub={`${fmt(porSemana)} por semana · ${mensCfg.length} loja${mensCfg.length !== 1 ? 's' : ''} pagando`}
          onClick={() => navigate('/super-admin/mensalidades')} />
        <Card titulo="Recebido este mês" valor={fmt(recebidoMes)} cor="var(--success)" sub="mensalidades pagas no mês"
          onClick={() => navigate('/super-admin/mensalidades')} />
        <Card titulo="Em aberto (vencido)" valor={fmt(totalEmAberto)} cor={totalEmAberto > 0 ? 'var(--danger)' : 'var(--text)'}
          sub={`${emAtraso.length} em atraso · ${bloqueadas.length} bloqueada${bloqueadas.length !== 1 ? 's' : ''}`}
          onClick={() => navigate('/super-admin/mensalidades')} />
        <Card titulo="Ativas" valor={ativas.length} cor="var(--success)" sub="lojas em operação" />
        <Card titulo="Em teste" valor={trial.length} cor="var(--primary)" sub="período de teste" />
        <Card titulo="Suspensas" valor={suspensas.length} cor="var(--danger)" sub="acesso bloqueado" />
        <Card titulo="Total" valor={empresas.length} sub="ver todas →" onClick={() => navigate('/super-admin/empresas')} />
      </div>

      {/* Card vendas App */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
        <div className="card" style={{ padding: '18px 22px' }}>
          <div style={{ fontSize: 11, color: '#f97316', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>Vendas App / Portal</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{fmt(gmvApp)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{pedidosApp.length} pedidos este mês</div>
          {comissaoAtiva && comissaoPct > 0 && (
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--success)', marginTop: 6 }}>
              +{fmt(comissaoMes)} comissão ({comissaoPct}%)
            </div>
          )}
        </div>
      </div>

      {/* Medidor de capacidade do sistema */}
      {cap && (
        <div className="card" style={{ marginBottom: 24, padding: '18px 22px' }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>📊 Capacidade do sistema</div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16, lineHeight: 1.5 }}>
            Uso atual × limite de cada parte. <span style={{ color: '#d97706', fontWeight: 700 }}>Amarelo</span> = comece a planejar o aumento; <span style={{ color: '#dc2626', fontWeight: 700 }}>vermelho</span> = no teto. Atualiza sozinho a cada 30s.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 14 }}>
            {CAP_METRICAS.map(m => {
              const val = Number(cap[m.key] ?? 0)
              const pct = Math.min(100, Math.round((val / m.limite) * 100))
              const cor   = val >= m.limite ? '#dc2626' : val >= m.alerta ? '#d97706' : '#16a34a'
              const fundo = val >= m.limite ? 'rgba(220,38,38,.10)' : val >= m.alerta ? 'rgba(217,119,6,.10)' : 'rgba(22,163,74,.08)'
              return (
                <div key={m.key} style={{ background: fundo, borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7, gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{m.label}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: cor, whiteSpace: 'nowrap' }}>
                      {val}{m.unidade}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}> / {m.limiteLabel}</span>
                    </span>
                  </div>
                  <div style={{ height: 8, borderRadius: 6, background: 'rgba(120,120,120,.18)', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: cor, borderRadius: 6, transition: 'width 400ms ease' }} />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{m.sub}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Mensalidades que vencem nos próximos 7 dias (cobrança semanal) */}
      {vencendo.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{
            padding: '12px 16px 10px', fontWeight: 700, fontSize: 14, color: 'var(--warning)',
            borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          }}>
            <span>⏳ Vencendo nos próximos 7 dias ({vencendo.length}) · {fmt(vencendo.reduce((s, c) => s + Number(c.valor), 0))}</span>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate('/super-admin/mensalidades')}>Mensalidades →</button>
          </div>
          <div className="data-table" style={{ marginBottom: 0 }}>
            <table>
              <thead>
                <tr><th>Empresa</th><th>Vence</th><th>Referência</th><th className="caixa-amount-col">Valor</th></tr>
              </thead>
              <tbody>
                {vencendo.map(c => (
                  <tr key={`${c.empresa_id}-${c.vencimento}`}>
                    <td style={{ fontWeight: 600 }}>{nomeLoja(c.empresa_id)}</td>
                    <td>
                      <span style={{ color: c.vencimento === hojeYmd ? 'var(--danger)' : 'var(--warning)', fontWeight: 700 }}>
                        {c.vencimento === hojeYmd ? 'hoje' : dataCurtaBR(c.vencimento)}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{c.referencia}</td>
                    <td className="caixa-amount-col">{fmt(c.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Link de indicação */}
      {refToken && (() => {
        const link = `${window.location.origin}/entrar?ref=${refToken}`
        function copiar() {
          navigator.clipboard.writeText(link)
          setCopiado(true)
          clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setCopiado(false), 2500)
        }
        return (
          <div className="card" style={{ marginBottom: 24, padding: '18px 20px' }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>🔗 Seu link de indicação</div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Quem se cadastrar pelo seu link entra na sua rede MLM e você ganha comissão nas compras deles.
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{
                flex: 1, minWidth: 0,
                background: 'var(--bg)', border: '1.5px solid var(--border)',
                borderRadius: 8, padding: '8px 12px',
                fontSize: 13, color: 'var(--text-muted)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {link}
              </div>
              <button onClick={copiar} style={{
                padding: '8px 18px', borderRadius: 8, border: 'none',
                cursor: 'pointer', fontWeight: 700, fontSize: 13,
                background: copiado ? '#16a34a' : 'var(--primary)',
                color: '#fff', whiteSpace: 'nowrap', transition: 'background 200ms',
              }}>
                {copiado ? '✓ Copiado!' : '📋 Copiar link'}
              </button>
            </div>
          </div>
        )
      })()}

      {/* Visão geral das empresas */}
      <div className="card">
        <div style={{
          padding: '12px 16px 10px',
          fontWeight: 700,
          fontSize: 14,
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          Todas as empresas
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/super-admin/empresas')}>
            Gerenciar →
          </button>
        </div>
        <div className="data-table" style={{ marginBottom: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Status</th>
                <th>Mensalidade</th>
                <th className="caixa-amount-col">WA</th>
              </tr>
            </thead>
            <tbody>
              {empresas.map(e => (
                <tr key={e.id}>
                  <td style={{ fontWeight: 500 }}>{e.nome}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGES[e.status] ?? 'badge-neutral'}`}>
                      {STATUS_LABELS[e.status] ?? e.status}
                    </span>
                  </td>
                  <td>{(() => {
                    const m = mensDe(e)
                    if (!m) return <span style={{ color: 'var(--text-muted)' }}>—</span>
                    const FASE = { em_dia: ['Em dia', 'var(--success)'], vence_hoje: ['Vence hoje', 'var(--warning)'], carencia: ['Atrasada', 'var(--danger)'], prazo: ['Prazo', 'var(--primary)'], bloqueio: ['BLOQUEADA', 'var(--danger)'] }
                    const [txt, cor] = FASE[m.estado.fase] ?? ['', 'var(--text-muted)']
                    return <>{fmt(m.cfg.valor)}<span style={{ color: 'var(--text-muted)' }}>/{m.cfg.periodicidade === 'semanal' ? 'sem' : 'mês'}</span> <strong style={{ color: cor, fontSize: 12 }}>{txt}</strong></>
                  })()}</td>
                  <td
                    className="caixa-amount-col"
                    style={{
                      fontWeight: 700,
                      color: (e.whatsapp_creditos ?? 0) === 0
                        ? 'var(--danger)'
                        : (e.whatsapp_creditos ?? 0) < 10
                          ? 'var(--warning)'
                          : 'var(--success)',
                    }}
                  >
                    {e.whatsapp_creditos ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
