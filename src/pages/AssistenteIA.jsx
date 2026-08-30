// Automação → Assistente IA (tela do lojista).
//
// Onde ele vê quanto ainda pode perguntar, o que já perguntou e quanto isso
// consumiu. A pergunta que essa tela responde é sempre a mesma: "posso continuar
// usando?" — por isso o número grande é PERGUNTAS, não reais. "R$ 3,40
// restantes" não diz nada pro dono de pizzaria; "dá pra mais 11 perguntas" diz.

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useIaConsumo } from '../hooks/useIaConsumo'
import '../components/Page.css'

const brl = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',')
const dataHora = (ts) => new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

const VALORES = [10, 20, 50, 100]

export default function AssistenteIA() {
  const c = useIaConsumo()
  const [extrato, setExtrato] = useState([])
  const [perguntas, setPerguntas] = useState([])
  const [pix, setPix] = useState(null)        // { qr_code, qr_code_base64, valor, mp_payment_id }
  const [gerando, setGerando] = useState(false)
  const [pago, setPago] = useState(false)
  const [erroPix, setErroPix] = useState(null)
  const [copiado, setCopiado] = useState(false)
  const timerRef = useRef(null)

  async function comprar(valor) {
    setGerando(true); setErroPix(null); setPago(false)
    const { data, error } = await supabase.functions.invoke('ia-saldo', {
      body: { acao: 'comprar', valor },
    })
    setGerando(false)
    if (error) {
      const d = await error.context?.json?.().catch(() => null)
      setErroPix(d?.error || 'Não consegui gerar o PIX agora. Tente de novo.')
      return
    }
    if (data?.error) { setErroPix(data.error); return }
    setPix(data)
  }

  // Pergunta ao servidor de tempos em tempos se o PIX já caiu. O webhook do
  // Mercado Pago às vezes demora, e o lojista está parado olhando a tela.
  useEffect(() => {
    if (!pix?.mp_payment_id || pago) return
    timerRef.current = setInterval(async () => {
      const { data } = await supabase.functions.invoke('ia-saldo', {
        body: { acao: 'conferir', mp_payment_id: pix.mp_payment_id },
      })
      if (data?.status === 'pago') {
        setPago(true)
        c.recarregar?.()
        carregarExtrato()
      } else if (data?.status === 'cancelado') {
        setErroPix('O PIX expirou. Gere um novo.')
        setPix(null)
      }
    }, 5000)
    return () => clearInterval(timerRef.current)
  }, [pix?.mp_payment_id, pago]) // eslint-disable-line react-hooks/exhaustive-deps

  function carregarExtrato() {
    supabase.from('ia_saldo_log')
      .select('tipo, valor_centavos, saldo_depois, descricao, created_at')
      .order('created_at', { ascending: false }).limit(30)
      .then(({ data }) => setExtrato(data ?? []))
  }

  useEffect(() => {
    const mesIni = new Date()
    mesIni.setDate(1); mesIni.setHours(0, 0, 0, 0)
    carregarExtrato()
    supabase.from('assistente_conversas')
      .select('pergunta, custo_brl, created_at')
      .gte('created_at', mesIni.toISOString())
      .order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setPerguntas(data ?? []))
    // Uma consulta ao servidor confere os PIX pendentes desta loja e credita o
    // que já foi pago — rede de segurança pra quando o webhook se perde.
    supabase.functions.invoke('ia-saldo', { body: { acao: 'saldo' } })
      .then(() => c.recarregar?.())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function copiarPix() {
    navigator.clipboard?.writeText(pix.qr_code)
    setCopiado(true)
    setTimeout(() => setCopiado(false), 2000)
  }

  if (c.carregando) return <p style={{ color: 'var(--text-muted)' }}>Carregando…</p>

  const acabou = c.disponivel <= 0
  const cor = acabou ? 'var(--danger)' : c.pct >= 80 ? 'var(--warning)' : 'var(--primary)'
  const proximoMes = new Date()
  proximoMes.setMonth(proximoMes.getMonth() + 1, 1)

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

      <div style={{ ...caixa, ...(acabou ? { background: 'var(--primary-bg)', borderColor: 'var(--primary-ring)' } : null) }}>
        <h2 style={titulo}>
          {acabou ? 'Seu assistente parou' : c.pct >= 80 ? 'Está acabando' : 'Comprar saldo'}
        </h2>
        <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: '0 0 14px', color: 'var(--text-muted)' }}>
          {acabou
            ? 'Ele volta sozinho quando o mês virar. Se não quiser esperar, compre saldo e continue perguntando agora.'
            : 'O saldo comprado não expira no fim do mês — ele só é usado depois que a franquia acaba.'}
        </p>

        {pago ? (
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--success)' }}>
            Pagamento confirmado! Seu saldo já está disponível. 🎉
          </div>
        ) : pix ? (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {pix.qr_code_base64 && (
              <img src={`data:image/png;base64,${pix.qr_code_base64}`} alt="QR Code do PIX"
                width={190} height={190}
                style={{ borderRadius: 10, background: '#fff', padding: 8, flexShrink: 0 }} />
            )}
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 6 }}>{brl(pix.valor)}</div>
              <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-muted)', margin: '0 0 10px' }}>
                Abra o aplicativo do banco, escolha PIX e leia o código.
                Assim que cair, o saldo entra sozinho — pode deixar esta tela aberta.
              </p>
              <button type="button" onClick={copiarPix} style={botao}>
                {copiado ? 'Copiado!' : 'Copiar código PIX'}
              </button>
              <button type="button" onClick={() => { setPix(null); setErroPix(null) }}
                style={{ ...botao, background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', marginLeft: 8 }}>
                Cancelar
              </button>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
                Aguardando o pagamento… O código vale por 30 minutos.
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {VALORES.map(v => (
              <button key={v} type="button" disabled={gerando} onClick={() => comprar(v)}
                style={{ ...botao, opacity: gerando ? .5 : 1 }}>
                {gerando ? 'Gerando…' : brl(v)}
              </button>
            ))}
          </div>
        )}

        {erroPix && <p style={{ fontSize: 13, color: 'var(--danger)', margin: '12px 0 0' }}>{erroPix}</p>}
      </div>

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
