import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { recadoDeErro } from '../lib/erroRede'
import '../components/Page.css'

// CONFERÊNCIA DO MÊS — o custo REAL da mercadoria contra o que as vendas PREVIAM.
//
// O lucro do dia usa um custo estimado (ficha técnica / % do vendido). Uma vez por mês o dono confere se a
// estimativa está certa com a conta de padaria (mig 0410, conferencia_mes):
//     consumo real = estoque no início + compras − estoque no fim
// Passou do previsto = o % de custo dos pratos está baixo, ou tem desperdício/desvio (a tela da Cozinha mostra onde).

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const r2 = (n) => Math.round(n * 100) / 100
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

const cartao = { background: 'var(--bg-card, var(--card, #fff))', border: '1px solid var(--border)', borderRadius: 14, padding: 14, marginBottom: 12 }
const linha = (forte) => ({ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', fontSize: forte ? 17 : 15, fontWeight: forte ? 800 : 400 })
const nav = { width: 44, height: 44, borderRadius: 999, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 20, cursor: 'pointer' }

export default function ConferenciaMes({ onContar }) {
  const hoje = new Date()
  const [mes, setMes] = useState({ a: hoje.getFullYear(), m: hoje.getMonth() })
  const [d, setD] = useState(null)
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [detalhe, setDetalhe] = useState(false)

  const ini = ymd(new Date(mes.a, mes.m, 1))
  const fim = ymd(new Date(mes.a, mes.m + 1, 0))
  const emAndamento = mes.a === hoje.getFullYear() && mes.m === hoje.getMonth()

  const carregar = useCallback(async () => {
    setCarregando(true)
    setErro(null)
    const { data, error } = await supabase.rpc('conferencia_mes', { p_ini: ini, p_fim: fim })
    if (error) setErro(recadoDeErro(error, 'carregar a conferência'))
    else setD(data)
    setCarregando(false)
  }, [ini, fim])

  useEffect(() => { carregar() }, [carregar])

  const c = useMemo(() => {
    if (!d) return null
    const estIni = r2(Number(d.insumos_ini) + Number(d.produtos_ini))
    const estFim = r2(Number(d.insumos_fim) + Number(d.produtos_fim))
    const compras = r2(Number(d.compras_insumos) + Number(d.compras_produtos))
    const real = r2(estIni + compras - estFim)
    const previsto = r2(Number(d.previsto_pratos) + Number(d.previsto_revenda))
    return { estIni, estFim, compras, real, previsto, dif: r2(real - previsto) }
  }, [d])

  const mudaMes = (n) => setMes(({ a, m }) => { const x = new Date(a, m + n, 1); return { a: x.getFullYear(), m: x.getMonth() } })
  const ehFuturo = new Date(mes.a, mes.m + 1, 1) > new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1)

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <button type="button" style={nav} onClick={() => mudaMes(-1)} aria-label="Mês anterior">‹</button>
        <div style={{ textAlign: 'center' }}>
          <b style={{ fontSize: 18 }}>{MESES[mes.m]} {mes.a}</b>
          {emAndamento && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>mês em andamento</div>}
        </div>
        <button type="button" style={{ ...nav, opacity: emAndamento || ehFuturo ? .35 : 1 }} disabled={emAndamento || ehFuturo} onClick={() => mudaMes(1)} aria-label="Próximo mês">›</button>
      </div>

      {erro && <div className="alert alert-error" style={{ marginBottom: 12 }}>{erro}</div>}
      {carregando && <div style={cartao}>Calculando…</div>}

      {!carregando && c && (
        <>
          <div style={cartao}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 4 }}>📦 QUANTO DE MERCADORIA FOI USADO DE VERDADE</div>
            <div style={linha()}><span>Estoque no início do mês</span><b>{brl(c.estIni)}</b></div>
            <div style={linha()}><span>+ Comprou no mês</span><b>{brl(c.compras)}</b></div>
            <div style={linha()}><span>− Estoque no fim</span><b>{brl(c.estFim)}</b></div>
            <div style={{ ...linha(true), borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 10 }}>
              <span>= Consumo real</span><span style={{ color: 'var(--primary)' }}>{brl(c.real)}</span>
            </div>
          </div>

          <div style={cartao}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 4 }}>🧮 O QUE AS VENDAS PREVIAM</div>
            <div style={linha()}><span>Pratos (ficha técnica / % do vendido)</span><b>{brl(d.previsto_pratos)}</b></div>
            <div style={linha()}><span>Revenda (bebida, industrializado)</span><b>{brl(d.previsto_revenda)}</b></div>
            <div style={{ ...linha(true), borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 10 }}>
              <span>= Previsto</span><span>{brl(c.previsto)}</span>
            </div>
            {c.previsto > 0 && (() => {
              const acima = c.dif > 0
              return (
                <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, fontWeight: 700, fontSize: 15,
                  background: acima ? 'rgba(220,38,38,.1)' : 'rgba(22,163,74,.1)', color: acima ? 'var(--danger, #dc2626)' : 'var(--success, #16a34a)' }}>
                  {Math.abs(c.dif) < 0.01 ? 'Bateu certinho.'
                    : acima ? `Saiu ${brl(c.dif)} A MAIS do que as vendas previam (${Math.round((c.dif / c.previsto) * 100)}% acima).`
                      : `Saiu ${brl(-c.dif)} A MENOS do que as vendas previam (${Math.round((-c.dif / c.previsto) * 100)}% abaixo).`}
                </div>
              )
            })()}
            {c.previsto <= 0 && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-muted)' }}>Sem vendas com custo cadastrado nesse mês — não há o que comparar.</div>}
          </div>

          {/* Avisos honestos: o número só vale se o dado de base vale */}
          {!d.contou_inicio && (
            <div style={{ ...cartao, background: 'rgba(245,158,11,.1)', borderColor: 'rgba(245,158,11,.4)', fontSize: 14 }}>
              ⚠️ <b>Mês de partida:</b> o estoque do início nunca foi contado, então o "estoque no início" é só o que o sistema achava. Conte no dia 1º antes de abrir e o mês seguinte fecha certo.
              {onContar && <div><button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={onContar}>📋 Contar estoque</button></div>}
            </div>
          )}
          {d.contou_inicio && !d.contou_fim && !emAndamento && (
            <div style={{ ...cartao, background: 'rgba(245,158,11,.1)', borderColor: 'rgba(245,158,11,.4)', fontSize: 14 }}>
              ⚠️ <b>Sem contagem no fim do mês:</b> o "estoque no fim" é o do sistema, então perda e desvio não aparecem no consumo real. Conte no dia 1º.
              {onContar && <div><button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={onContar}>📋 Contar estoque</button></div>}
            </div>
          )}
          {(d.produtos_sem_custo > 0 || d.insumos_sem_custo > 0) && (
            <div style={{ ...cartao, background: 'rgba(245,158,11,.1)', borderColor: 'rgba(245,158,11,.4)', fontSize: 14 }}>
              ⚠️ {d.produtos_sem_custo > 0 && <><b>{d.produtos_sem_custo}</b> produto{d.produtos_sem_custo > 1 ? 's' : ''} com estoque e <b>custo zero</b></>}
              {d.produtos_sem_custo > 0 && d.insumos_sem_custo > 0 && ' e '}
              {d.insumos_sem_custo > 0 && <><b>{d.insumos_sem_custo}</b> insumo{d.insumos_sem_custo > 1 ? 's' : ''} sem custo</>}
              : o estoque deles vale R$ 0 e o consumo real sai errado. Preencha o custo (ele se acerta sozinho conforme você lança compras).
            </div>
          )}
          {emAndamento && (
            <div style={{ ...cartao, fontSize: 13, color: 'var(--text-muted)' }}>
              O mês ainda não acabou: o previsto e o real crescem juntos. A conferência mais confiável é a do mês fechado.
            </div>
          )}

          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDetalhe(v => !v)} style={{ marginBottom: 12 }}>
            {detalhe ? 'Esconder detalhes' : 'Ver detalhes por estoque'}
          </button>
          {detalhe && (
            <div style={cartao}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>Insumos (almoxarifado)</div>
              <div style={linha()}><span>Início</span><span>{brl(d.insumos_ini)}</span></div>
              <div style={linha()}><span>Compras</span><span>{brl(d.compras_insumos)}</span></div>
              <div style={linha()}><span>Fim</span><span>{brl(d.insumos_fim)}</span></div>
              <div style={{ fontWeight: 800, margin: '12px 0 4px' }}>Revenda (produtos com estoque)</div>
              <div style={linha()}><span>Início</span><span>{brl(d.produtos_ini)}</span></div>
              <div style={linha()}><span>Compras</span><span>{brl(d.compras_produtos)}</span></div>
              <div style={linha()}><span>Fim</span><span>{brl(d.produtos_fim)}</span></div>
              <div style={{ fontWeight: 800, margin: '12px 0 4px' }}>Cozinha (entregas registradas)</div>
              <div style={linha()}><span>Entregue</span><span>{brl(d.cozinha_entregue)}</span></div>
              <div style={linha()}><span>Usado (entregue − sobra)</span><span>{brl(d.cozinha_usado)}</span></div>
              {d.cozinha_sem_sobra > 0 && <div style={{ fontSize: 13, color: '#b45309' }}>⏳ {d.cozinha_sem_sobra} entrega{d.cozinha_sem_sobra > 1 ? 's' : ''} sem a sobra registrada.</div>}
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 10 }}>
                O estoque é valorizado no custo médio de hoje do cadastro — serve pra conferir, não é contabilidade.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
