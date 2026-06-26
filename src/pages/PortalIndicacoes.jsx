import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import './PortalHome.css'

const CORES_NIVEL = ['', '#7c3aed', '#2563eb', '#0891b2', '#15803d', '#b45309']

function fmt(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function fmtPts(v) {
  return Number(v || 0).toLocaleString('pt-BR')
}

export default function PortalIndicacoes() {
  const [profile, setProfile]         = useState(null)
  const [rede, setRede]               = useState({})
  const [ganhos, setGanhos]           = useState({})
  const [recentes, setRecentes]       = useState([])
  const [cashbacks, setCashbacks]     = useState([])
  const [saldo, setSaldo]             = useState(null)
  const [cfgs, setCfgs]               = useState({})
  const [niveisInfo, setNiveisInfo]   = useState([])
  const [aba, setAba]                 = useState('cashback')
  const [copiado, setCopiado]         = useState(false)
  const [loading, setLoading]         = useState(true)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const viewAsRaw = localStorage.getItem('crm_view_as')
      const viewAs = viewAsRaw ? JSON.parse(viewAsRaw) : null
      const userId = viewAs?.id ?? user.id

      const [profileRes, redeRes, ganhosRes, recentesRes, saldoRes, cfgsRes, cbRes] = await Promise.all([
        supabase.from('profiles').select('nome, ref_token').eq('id', userId).single(),

        supabase.from('indicacao_arvore')
          .select('depth').eq('ancestor_id', userId).gt('depth', 0).lte('depth', 5),

        supabase.from('comissoes_indicacao')
          .select('nivel, valor_comissao, pontos, status').eq('beneficiario_id', userId),

        supabase.from('comissoes_indicacao')
          .select('nivel, valor_comissao, pontos, status, created_at, comprador:comprador_id(nome, username)')
          .eq('beneficiario_id', userId)
          .order('created_at', { ascending: false }).limit(10),

        supabase.from('saldo_pontos').select('*').eq('profile_id', userId).single(),

        supabase.from('configuracoes_plataforma')
          .select('chave, valor')
          .in('chave', ['valor_ponto_reais','valor_resgate_ponto','pontos_minimo_resgate',
                        'mlm_pct_nivel_1','mlm_pct_nivel_2','mlm_pct_nivel_3',
                        'mlm_pct_nivel_4','mlm_pct_nivel_5',
                        'mlm_ativo','cashback_pct','cashback_ativo','acumulado_pct_diretos']),

        supabase.from('cashback_transacoes')
          .select('valor_venda, valor_cashback, pontos, status, created_at')
          .eq('profile_id', userId)
          .order('created_at', { ascending: false }).limit(10),
      ])

      setProfile(profileRes.data)

      const redeMap = {}
      for (const row of redeRes.data ?? []) redeMap[row.depth] = (redeMap[row.depth] ?? 0) + 1
      setRede(redeMap)

      const ganhosMap = {}
      for (const row of ganhosRes.data ?? []) {
        if (!ganhosMap[row.nivel]) ganhosMap[row.nivel] = { total: 0, totalPts: 0, pago: 0 }
        ganhosMap[row.nivel].total    += Number(row.valor_comissao)
        ganhosMap[row.nivel].totalPts += Number(row.pontos ?? 0)
        if (row.status === 'pago') ganhosMap[row.nivel].pago += Number(row.valor_comissao)
      }
      setGanhos(ganhosMap)
      setRecentes(recentesRes.data ?? [])
      setSaldo(saldoRes.data ?? { pontos: 0, pontos_acumulados: 0, pontos_resgatados: 0 })

      const cfgMap = {}
      for (const r of cfgsRes.data ?? []) cfgMap[r.chave] = r.valor
      setCfgs(cfgMap)

      setNiveisInfo([1,2,3,4,5].map(n => ({
        nivel: n, label: `${n}º nível`,
        pct: cfgMap[`mlm_pct_nivel_${n}`] ?? ['3.0','1.5','0.8','0.4','0.2'][n-1],
        cor: CORES_NIVEL[n],
      })))
      setCashbacks(cbRes.data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  const refLink = profile?.ref_token
    ? `${window.location.origin}/entrar?ref=${profile.ref_token}`
    : ''

  async function copiar() {
    if (!refLink) return
    await navigator.clipboard.writeText(refLink)
    setCopiado(true)
    setTimeout(() => setCopiado(false), 2000)
  }

  const totalRede        = Object.values(rede).reduce((s, v) => s + v, 0)
  const pontosDisp       = saldo?.pontos ?? 0
  const pontosAcum       = saldo?.pontos_acumulados ?? 0
  const valorGanho       = Number(cfgs.valor_ponto_reais ?? 1)
  const cbPct            = Number(cfgs.cashback_pct ?? 2)
  const valorDesconto    = Number(cfgs.valor_resgate_ponto ?? (cbPct / 100 * valorGanho))
  const mlmAtivo         = cfgs.mlm_ativo !== 'false'
  const cbAtivo          = cfgs.cashback_ativo !== 'false'
  const spilloverPct     = Number(cfgs.acumulado_pct_diretos ?? 20)
  const totalCbPontos    = cashbacks.reduce((s, c) => s + Number(c.pontos ?? 0), 0)
  const totalComissaoReais = Object.values(ganhos).reduce((s, g) => s + (g.total ?? 0), 0)
  const totalCbValor     = cashbacks.reduce((s, c) => s + Number(c.valor_cashback || 0), 0)
  const saldoEmReais     = totalComissaoReais + totalCbValor

  if (loading) return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 40, color: 'var(--text-muted)' }}>Carregando...</div>
  )

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', padding: '20px 16px 100px' }}>

      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>Pontos & Cashback</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
          R$1 gasto = 1 ponto &nbsp;·&nbsp; use seus pontos como desconto nas próximas compras
        </p>
      </div>

      {/* ”€”€ DOIS CONTADORES ”€”€ */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>

        {/* Saldo disponível */}
        <div style={{
          background: 'linear-gradient(135deg, #16a34a 0%, #15803d 100%)',
          borderRadius: 16, padding: '18px 16px', color: '#fff',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.85, marginBottom: 4, letterSpacing: '0.04em' }}>
            SALDO DISPONÍVEL
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, lineHeight: 1 }}>
            {fmtPts(pontosDisp)}
          </div>
          <div style={{ fontSize: 11, opacity: 0.8, marginTop: 4 }}>pontos</div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8, opacity: 0.95 }}>
            = {fmt(saldoEmReais)}
          </div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>em desconto nas compras</div>
        </div>

        {/* Pontos acumulados */}
        <div style={{
          background: 'linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%)',
          borderRadius: 16, padding: '18px 16px', color: '#fff',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.85, marginBottom: 4, letterSpacing: '0.04em' }}>
            ACUMULADO PRÊMIOS
          </div>
          <div style={{ fontSize: 28, fontWeight: 900, lineHeight: 1 }}>
            {fmtPts(pontosAcum)}
          </div>
          <div style={{ fontSize: 11, opacity: 0.8, marginTop: 4 }}>pontos</div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8, opacity: 0.95 }}>
            nunca diminui
          </div>
          <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>só para trocar por prêmios</div>
        </div>
      </div>

      {/* Como usar o saldo de pontos (desconto em compras) */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
          Como usar seu saldo
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Seus pontos viram <strong style={{ color: 'var(--primary)' }}>desconto nas suas próximas compras</strong> dentro do app. Cada ponto vale {fmt(valorDesconto)} de desconto — é só avisar na hora de comprar.
        </div>
      </div>

      {/* Abas */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {cbAtivo && (
          <button onClick={() => setAba('cashback')} style={{
            flex: 1, padding: '9px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: aba === 'cashback' ? 'var(--primary)' : 'var(--surface)',
            color: aba === 'cashback' ? '#fff' : 'var(--text)',
            outline: `1.5px solid ${aba === 'cashback' ? 'var(--primary)' : 'var(--border)'}`,
          }}>
            💰 Cashback
          </button>
        )}
        {mlmAtivo && (
          <button onClick={() => setAba('indicacoes')} style={{
            flex: 1, padding: '9px 0', borderRadius: 10, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 13,
            background: aba === 'indicacoes' ? 'var(--primary)' : 'var(--surface)',
            color: aba === 'indicacoes' ? '#fff' : 'var(--text)',
            outline: `1.5px solid ${aba === 'indicacoes' ? 'var(--primary)' : 'var(--border)'}`,
          }}>
            🔗 Indicações
          </button>
        )}
      </div>

      {/* ”€”€ ABA CASHBACK ”€”€ */}
      {aba === 'cashback' && cbAtivo && (
        <>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Como funciona</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Cada real gasto vira <strong style={{ color: 'var(--primary)' }}>1 ponto</strong>. Seus pontos
              {' '}viram <strong style={{ color: 'var(--primary)' }}>desconto nas próximas compras</strong> dentro do app.
            </div>
            {spilloverPct > 0 && (
              <div style={{
                marginTop: 10, padding: '8px 12px', borderRadius: 8,
                background: 'rgba(124,58,237,.08)', border: '1px solid rgba(124,58,237,.2)',
                fontSize: 12, color: 'var(--text)',
              }}>
                Toda compra feita por <strong>qualquer pessoa abaixo de você</strong> (qualquer nível) soma {spilloverPct}% no seu <span style={{ color: '#7c3aed', fontWeight: 700 }}>acumulado de prêmios</span> €” independente da profundidade.
              </div>
            )}
            <div style={{
              marginTop: 10, padding: '8px 12px', borderRadius: 8,
              background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.2)',
              fontSize: 12,
            }}>
              Compra de <strong>R$ 100,00</strong> †’ <strong style={{ color: 'var(--success)' }}>{Math.floor(100 / valorGanho)} pontos</strong>
              {' '}†’ {fmt(Math.floor(100 / valorGanho) * valorDesconto)} de desconto nas próximas compras
            </div>
          </div>

          {cashbacks.length > 0 ? (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
                Últimos cashbacks
                <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>
                  · {fmtPts(totalCbPontos)} pts no total
                </span>
              </div>
              {cashbacks.map((c, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '9px 0', borderBottom: i < cashbacks.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>Compra de {fmt(c.valor_venda)}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {new Date(c.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--success)' }}>+{fmtPts(c.pontos)} pts</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmt(c.valor_cashback)}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)', background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>💰</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Nenhum cashback ainda</div>
              <div style={{ fontSize: 13 }}>Faça uma compra e ganhe pontos automaticamente.</div>
            </div>
          )}
        </>
      )}

      {/* ”€”€ ABA INDICAÇÕES ”€”€ */}
      {aba === 'indicacoes' && mlmAtivo && (
        <>
          {/* Link */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>Seu link de indicação</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input readOnly value={refLink} onFocus={e => e.target.select()} style={{
                flex: 1, padding: '9px 12px', borderRadius: 8, border: '1.5px solid var(--border)',
                background: 'var(--bg)', color: 'var(--text)', fontSize: 12, fontFamily: 'monospace',
              }} />
              <button onClick={copiar} style={{
                padding: '9px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', flexShrink: 0,
                background: copiado ? 'var(--success)' : 'var(--primary)',
                color: '#fff', fontWeight: 700, fontSize: 13,
              }}>
                {copiado ? 'œ“ Copiado!' : 'Copiar'}
              </button>
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
              Quando seu indicado comprar, você ganha comissão em pontos €” e {spilloverPct}% dos pontos de cashback deles vai pro seu acumulado.
            </p>
          </div>

          {/* Rede €” tabela por nível */}
          {(() => {
            const totalPtsGanhos = niveisInfo.reduce((s, n) => s + (ganhos[n.nivel]?.totalPts ?? 0), 0)
            return (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    Sua rede €” <span style={{ color: 'var(--primary)' }}>{totalRede} pessoa{totalRede !== 1 ? 's' : ''}</span>
                  </div>
                  {totalPtsGanhos > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      total: <strong style={{ color: 'var(--primary)' }}>{fmtPts(totalPtsGanhos)} pts</strong>
                    </div>
                  )}
                </div>

                {/* cabeçalho */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '36px 1fr 44px 70px 70px',
                  gap: 0, padding: '5px 4px', marginBottom: 4,
                  borderBottom: '1.5px solid var(--border)',
                  fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.04em',
                }}>
                  <span>NÍV.</span>
                  <span>PESSOAS</span>
                  <span style={{ textAlign: 'right' }}>COM.</span>
                  <span style={{ textAlign: 'right' }}>PTS</span>
                  <span style={{ textAlign: 'right' }}>R$ GANHO</span>
                </div>

                {/* linhas */}
                {niveisInfo.map((n, i) => {
                  const pts = ganhos[n.nivel]?.totalPts ?? 0
                  const reais = ganhos[n.nivel]?.total ?? 0
                  const pessoas = rede[n.nivel] ?? 0
                  const isLast = i === niveisInfo.length - 1
                  return (
                    <div key={n.nivel} style={{
                      display: 'grid', gridTemplateColumns: '36px 1fr 44px 70px 70px',
                      gap: 0, padding: '9px 4px',
                      borderBottom: isLast ? 'none' : '1px solid var(--border)',
                      alignItems: 'center',
                    }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: 7, background: n.cor + '22',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, fontWeight: 800, color: n.cor,
                      }}>{n.nivel}</div>
                      <div style={{ fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>{n.label}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>
                          {pessoas} {pessoas !== 1 ? 'pessoas' : 'pessoa'}
                        </span>
                      </div>
                      <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 700, color: n.cor }}>
                        {Number(n.pct).toFixed(1)}%
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {pts > 0
                          ? <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--primary)' }}>{fmtPts(pts)}</span>
                          : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>€”</span>
                        }
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {reais > 0
                          ? <span style={{ fontSize: 13, fontWeight: 800, color: '#16a34a' }}>{fmt(reais)}</span>
                          : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>€”</span>
                        }
                      </div>
                    </div>
                  )
                })}

                {/* total comissões */}
                {totalPtsGanhos > 0 && (
                  <div style={{
                    display: 'grid', gridTemplateColumns: '36px 1fr 44px 70px 70px',
                    gap: 0, padding: '9px 4px',
                    borderTop: '1.5px solid var(--border)', marginTop: 2,
                    alignItems: 'center',
                  }}>
                    <div />
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>COMISSÕES</div>
                    <div />
                    <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 900, color: 'var(--primary)' }}>
                      {fmtPts(totalPtsGanhos)}
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 900, color: '#16a34a' }}>
                      {fmt(totalComissaoReais)}
                    </div>
                  </div>
                )}

                {/* cashback próprio */}
                {(totalCbPontos > 0 || totalCbValor > 0) && (
                  <div style={{
                    display: 'grid', gridTemplateColumns: '36px 1fr 44px 70px 70px',
                    gap: 0, padding: '9px 4px',
                    borderTop: '1px solid var(--border)',
                    alignItems: 'center',
                  }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: 7, background: 'rgba(245,158,11,.15)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14,
                    }}>💰</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>Cashback próprio</div>
                    <div />
                    <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 800, color: 'var(--primary)' }}>
                      {totalCbPontos > 0 ? fmtPts(totalCbPontos) : '€”'}
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 800, color: '#16a34a' }}>
                      {totalCbValor > 0 ? fmt(totalCbValor) : '€”'}
                    </div>
                  </div>
                )}

                {/* total geral */}
                {(totalPtsGanhos > 0 || totalCbPontos > 0) && (
                  <div style={{
                    display: 'grid', gridTemplateColumns: '36px 1fr 44px 70px 70px',
                    gap: 0, padding: '9px 4px',
                    borderTop: '2px solid var(--border)', marginTop: 2,
                    alignItems: 'center',
                    background: 'rgba(34,197,94,.05)', borderRadius: '0 0 8px 8px',
                  }}>
                    <div />
                    <div style={{ fontSize: 12, fontWeight: 800 }}>TOTAL GERAL</div>
                    <div />
                    <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 900, color: 'var(--primary)' }}>
                      {fmtPts(totalPtsGanhos + totalCbPontos)}
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 900, color: '#16a34a' }}>
                      {fmt(saldoEmReais)}
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Últimas comissões */}
          {recentes.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Últimas comissões</div>
              {recentes.map((c, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 0', borderBottom: i < recentes.length - 1 ? '1px solid var(--border)' : 'none',
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{c.nivel}º nível</div>
                    {(c.comprador?.username || c.comprador?.nome) && (
                      <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600 }}>
                        @{c.comprador.username || c.comprador.nome.split(' ')[0].toLowerCase()}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {new Date(c.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--primary)' }}>+{fmtPts(c.pontos ?? 0)} pts</div>
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                      background: c.status === 'pago' ? 'rgba(34,197,94,.15)' : 'rgba(245,158,11,.15)',
                      color: c.status === 'pago' ? 'var(--success)' : 'var(--warning)',
                    }}>
                      {c.status === 'pago' ? 'Pago' : 'Pendente'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {recentes.length === 0 && totalRede === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>🔗</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Compartilhe seu link!</div>
              <div style={{ fontSize: 13 }}>Assim que alguém comprar pelo seu link, aparece aqui.</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
