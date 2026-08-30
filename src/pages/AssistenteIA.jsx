// Automação → Assistente IA (tela do lojista).
//
// Onde ele vê quanto ainda pode perguntar, o que já perguntou e quanto isso
// consumiu. A pergunta que essa tela responde é sempre a mesma: "posso continuar
// usando?" — por isso o número grande é PERGUNTAS, não reais. "R$ 3,40
// restantes" não diz nada pro dono de pizzaria; "dá pra mais 11 perguntas" diz.

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { useIaConsumo } from '../hooks/useIaConsumo'
import '../components/Page.css'

const brl = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',')
const dataHora = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

// Enquanto a compra por PIX não existe, comprar saldo é falar com a gente.
const WHATSAPP_FWC = '5584998180774'

export default function AssistenteIA() {
  const { empresa } = useAuth()
  const c = useIaConsumo()
  const [extrato, setExtrato] = useState([])
  const [perguntas, setPerguntas] = useState([])

  useEffect(() => {
    const mesIni = new Date()
    mesIni.setDate(1); mesIni.setHours(0, 0, 0, 0)
    supabase.from('ia_saldo_log')
      .select('tipo, valor_centavos, saldo_depois, descricao, created_at')
      .order('created_at', { ascending: false }).limit(30)
      .then(({ data }) => setExtrato(data ?? []))
    supabase.from('assistente_conversas')
      .select('pergunta, custo_brl, created_at')
      .gte('created_at', mesIni.toISOString())
      .order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setPerguntas(data ?? []))
  }, [])

  if (c.carregando) return <p style={{ color: 'var(--text-muted)' }}>Carregando…</p>

  const acabou = c.disponivel <= 0
  const cor = acabou ? 'var(--danger)' : c.pct >= 80 ? 'var(--warning)' : 'var(--primary)'
  const proximoMes = new Date()
  proximoMes.setMonth(proximoMes.getMonth() + 1, 1)

  const texto = encodeURIComponent(
    `Olá! Sou da ${empresa?.nome ?? 'minha loja'} e quero comprar saldo para o Assistente IA.`)

  return (
    <div>
      <div className="page-header"><h1>Assistente IA</h1></div>
      <p style={{ fontSize: 13.5, color: 'var(--text-muted)', margin: '-10px 0 18px' }}>
        O robô do canto da tela que responde sobre a sua loja. Cada pergunta que ele
        responde consome um pouquinho — aqui você acompanha quanto ainda dá pra usar.
      </p>

      <div style={{ ...caixa, borderColor: acabou ? 'var(--danger)' : 'var(--border)' }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Ainda dá pra fazer</div>
        <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1, color: cor }}>
          {acabou ? 'Acabou' : `~${c.perguntasRestantes}`}
        </div>
        {!acabou && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>perguntas neste mês</div>}

        <div style={{ height: 8, borderRadius: 999, background: 'var(--border)', overflow: 'hidden', margin: '10px 0 8px' }}>
          <div style={{ height: '100%', width: `${c.pct}%`, background: cor, borderRadius: 999, transition: 'width 400ms' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-muted)', flexWrap: 'wrap', gap: 8 }}>
          <span>{brl(c.usado)} de {brl(c.franquia)} usados · {c.perguntas} perguntas</span>
          {c.saldo > 0 && <span>+ {brl(c.saldo)} de saldo comprado</span>}
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '12px 0 0' }}>
          Renova em {proximoMes.toLocaleDateString('pt-BR')}.
        </p>
      </div>

      {(acabou || c.pct >= 80) && (
        <div style={{ ...caixa, background: 'var(--primary-bg)', borderColor: 'var(--primary-ring)' }}>
          <h2 style={titulo}>{acabou ? 'Seu assistente parou' : 'Está acabando'}</h2>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: '0 0 12px' }}>
            {acabou
              ? 'Ele volta sozinho quando o mês virar. Se não quiser esperar, compre saldo e continue perguntando hoje mesmo.'
              : 'Quando acabar, o robô para até virar o mês. Dá pra comprar saldo e não ficar sem.'}
          </p>
          <a href={`https://wa.me/${WHATSAPP_FWC}?text=${texto}`} target="_blank" rel="noreferrer" style={botao}>
            Comprar saldo pelo WhatsApp
          </a>
        </div>
      )}

      <div style={caixa}>
        <h2 style={titulo}>Como funciona</h2>
        <ul style={{ fontSize: 13.5, lineHeight: 1.7, margin: 0, paddingLeft: 18, color: 'var(--text-muted)' }}>
          <li>Sua mensalidade já inclui <strong style={{ color: 'var(--text)' }}>{brl(c.franquia)} por mês</strong> de assistente.</li>
          <li>Pergunta simples consome menos, pergunta que puxa muito dado consome mais.</li>
          <li>Acabou a franquia, sai do saldo comprado. Sem saldo, o robô descansa até o dia 1.</li>
          <li>Ver seus números pelas telas do sistema <strong style={{ color: 'var(--text)' }}>não consome nada</strong> — o Dashboard e os Relatórios continuam liberados sempre.</li>
        </ul>
      </div>

      {extrato.length > 0 && (
        <div style={caixa}>
          <h2 style={titulo}>Extrato do saldo</h2>
          {extrato.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', fontSize: 13, borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <span>{m.descricao || (m.tipo === 'credito' ? 'Saldo adicionado' : 'Uso do assistente')}</span>
              <span style={{ whiteSpace: 'nowrap', color: m.valor_centavos >= 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                {m.valor_centavos >= 0 ? '+' : '−'} {brl(Math.abs(m.valor_centavos) / 100)}
                <span style={{ color: 'var(--text-muted)', marginLeft: 8, fontSize: 11.5 }}>{dataHora(m.created_at)}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={caixa}>
        <h2 style={titulo}>O que você perguntou neste mês</h2>
        {perguntas.length === 0
          ? <p style={{ fontSize: 13.5, color: 'var(--text-muted)', margin: 0 }}>Nenhuma pergunta ainda. O robô fica no canto de baixo da tela.</p>
          : perguntas.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', fontSize: 13, borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <span>{p.pergunta}</span>
              <span style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)', fontSize: 11.5 }}>
                {brl(p.custo_brl)} · {dataHora(p.created_at)}
              </span>
            </div>
          ))}
      </div>
    </div>
  )
}

const caixa = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 14, padding: 18, marginBottom: 18,
}
const titulo = { fontSize: 15, fontWeight: 700, margin: '0 0 10px' }
const botao = {
  display: 'inline-block', padding: '11px 18px', borderRadius: 10,
  background: 'var(--primary)', color: 'var(--primary-contrast)',
  fontWeight: 800, fontSize: 14, textDecoration: 'none',
}
