import { useEffect, useState } from 'react'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { hojeBR } from '../lib/feriados'

// Quanto o robô custou × quanto ele vendeu, no mesmo canto em que a loja compra
// crédito. O dono da CDBom pôs R$ 700 de crédito e quis saber, dia a dia, se o
// robô se paga (13/09/2026).
//
// Custo: cada resposta do robô desconta 1 crédito e grava uma linha "consumo"
// em whatsapp_credito_historico. Venda: pedido que nasceu na conversa do
// WhatsApp (pedidos_delivery.origem = 'whatsapp'), fora os cancelados.

const PRECO_CREDITO = 0.07
const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const PERIODOS = [
  { id: 'hoje',  label: 'Hoje',     dias: 0 },
  { id: 'ontem', label: 'Ontem',    dias: 1, soUmDia: true },
  { id: '7',     label: '7 dias',   dias: 6 },
  { id: '30',    label: '30 dias',  dias: 29 },
]

function somaDias(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

// Dia da loja (America/Fortaleza) de um timestamp.
const diaDaLoja = iso => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(iso))

export default function RoboRetorno({ empresaId }) {
  const [periodo, setPeriodo] = useState('hoje')
  const [dados, setDados] = useState(null)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    if (!empresaId) return
    let vivo = true
    ;(async () => {
      setDados(null); setErro(null)
      const p = PERIODOS.find(x => x.id === periodo)
      const hoje = hojeBR()
      const ini = p.soUmDia ? somaDias(hoje, -1) : somaDias(hoje, -p.dias)
      const fim = p.soUmDia ? hoje : somaDias(hoje, 1)
      const de = `${ini}T00:00:00-03:00`
      const ate = `${fim}T00:00:00-03:00`

      const [consumo, pedidos] = await Promise.all([
        fetchAll(() => supabase.from('whatsapp_credito_historico')
          .select('created_at, creditos')
          .eq('empresa_id', empresaId).eq('tipo', 'consumo')
          .gte('created_at', de).lt('created_at', ate)
          .order('created_at')),
        fetchAll(() => supabase.from('pedidos_delivery')
          .select('created_at, total, status')
          .eq('empresa_id', empresaId).eq('origem', 'whatsapp')
          .neq('status', 'cancelado')
          .gte('created_at', de).lt('created_at', ate)
          .order('created_at')),
      ])
      if (!vivo) return
      if (consumo.error || pedidos.error) { setErro('Não consegui carregar agora.'); return }

      const porDia = {}
      const dia = d => (porDia[d] ??= { respostas: 0, pedidos: 0, vendas: 0 })
      for (const c of consumo.data) dia(diaDaLoja(c.created_at)).respostas += Math.abs(Number(c.creditos) || 1)
      for (const o of pedidos.data) {
        const x = dia(diaDaLoja(o.created_at))
        x.pedidos += 1
        x.vendas += Number(o.total) || 0
      }
      const respostas = Object.values(porDia).reduce((s, d) => s + d.respostas, 0)
      const qtdPedidos = pedidos.data.length
      const vendas = pedidos.data.reduce((s, o) => s + (Number(o.total) || 0), 0)
      setDados({
        respostas, gasto: respostas * PRECO_CREDITO, qtdPedidos, vendas,
        dias: Object.entries(porDia).sort((a, b) => b[0].localeCompare(a[0])),
      })
    })()
    return () => { vivo = false }
  }, [empresaId, periodo])

  const retorno = dados && dados.gasto > 0 ? dados.vendas / dados.gasto : null
  const umDia = periodo === 'hoje' || periodo === 'ontem'

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800 }}>🤖 Gasto do robô × vendas do robô</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Quanto de crédito o robô usou e quanto vendeu pelo WhatsApp</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PERIODOS.map(p => (
            <button key={p.id} type="button" onClick={() => setPeriodo(p.id)} style={{
              padding: '6px 12px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
              background: periodo === p.id ? 'var(--primary)' : 'var(--bg)',
              color: periodo === p.id ? '#fff' : 'var(--text)',
              outline: `1.5px solid ${periodo === p.id ? 'var(--primary)' : 'var(--border)'}`,
            }}>{p.label}</button>
          ))}
        </div>
      </div>

      {erro && <div style={{ fontSize: 13, color: 'var(--danger)' }}>{erro}</div>}
      {!erro && !dados && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Carregando...</div>}

      {dados && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            <Bloco titulo="Gasto de crédito" valor={fmt(dados.gasto)}
              detalhe={`${dados.respostas} resposta${dados.respostas === 1 ? '' : 's'} do robô`} />
            <Bloco titulo="Vendas pelo robô" valor={fmt(dados.vendas)} destaque
              detalhe={`${dados.qtdPedidos} pedido${dados.qtdPedidos === 1 ? '' : 's'}`} />
            <Bloco titulo="Retorno"
              valor={retorno == null ? '—' : `${retorno.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}x`}
              detalhe={retorno == null ? 'o robô ainda não gastou nada' : `cada R$ 1 no robô virou ${fmt(retorno)} em venda`} />
          </div>

          {!umDia && dados.dias.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: 16 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={th}>Dia</th><th style={thNum}>Gasto</th><th style={thNum}>Pedidos</th><th style={thNum}>Vendas</th>
                  </tr>
                </thead>
                <tbody>
                  {dados.dias.map(([d, v]) => (
                    <tr key={d} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={td}>{d.split('-').reverse().slice(0, 2).join('/')}</td>
                      <td style={tdNum}>{fmt(v.respostas * PRECO_CREDITO)}</td>
                      <td style={tdNum}>{v.pedidos}</td>
                      <td style={{ ...tdNum, fontWeight: 700 }}>{fmt(v.vendas)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>
            Cada resposta do robô usa 1 crédito ({fmt(PRECO_CREDITO)}). Vendas = pedidos fechados na conversa do WhatsApp, sem os cancelados.
            Quem pegou o link do cardápio com o robô e pediu pela Loja Online não entra aqui.
          </div>
        </>
      )}
    </div>
  )
}

function Bloco({ titulo, valor, detalhe, destaque }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 12,
      background: destaque ? 'rgba(34,197,94,.10)' : 'var(--bg)',
      border: `1px solid ${destaque ? 'rgba(34,197,94,.35)' : 'var(--border)'}`,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{titulo}</div>
      <div style={{ fontSize: 24, fontWeight: 900, marginTop: 4, color: destaque ? 'var(--success, #16a34a)' : 'var(--text)' }}>{valor}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{detalhe}</div>
    </div>
  )
}

const th = { padding: '6px 8px', fontWeight: 700 }
const thNum = { ...th, textAlign: 'right' }
const td = { padding: '6px 8px' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
