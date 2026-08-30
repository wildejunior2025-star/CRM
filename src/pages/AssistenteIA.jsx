// Automação → Assistente IA (tela do lojista).
//
// Onde ele vê quanto ainda pode perguntar, o que já perguntou e quanto isso
// consumiu. A pergunta que essa tela responde é sempre a mesma: "posso continuar
// usando?"
//
// O número grande é em REAIS, e não em "quantas perguntas ainda dá". Chegamos a
// mostrar a contagem e ela saiu: o custo depende do tanto de dado que a IA
// precisa levantar, então qualquer contagem é chute — e é o tipo de chute que o
// dono cobra da gente depois, quando não bate.
//
// O "como funciona" fica escondido atrás do "?" de propósito. É coisa que se lê
// uma vez; aberto na tela toda hora vira parede de texto que ele pula — e aí
// some junto o aviso que importa (usar o sistema não consome nada).

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useIaConsumo } from '../hooks/useIaConsumo'
import { dataBR } from '../lib/cicloIa'
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
  const [comoFunciona, setComoFunciona] = useState(false)
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
    if (!c.cicloIni) return
    carregarExtrato()
    supabase.from('assistente_conversas')
      .select('pergunta, custo_brl, created_at')
      .gte('created_at', c.cicloIni.toISOString())
      .order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setPerguntas(data ?? []))
    // Uma consulta ao servidor confere os PIX pendentes desta loja e credita o
    // que já foi pago — rede de segurança pra quando o webhook se perde.
    supabase.functions.invoke('ia-saldo', { body: { acao: 'saldo' } })
      .then(() => c.recarregar?.())
  }, [c.cicloIni?.getTime()]) // eslint-disable-line react-hooks/exhaustive-deps

  function copiarPix() {
    navigator.clipboard?.writeText(pix.qr_code)
    setCopiado(true)
    setTimeout(() => setCopiado(false), 2000)
  }

  if (c.carregando) return <p style={{ color: 'var(--text-muted)' }}>Carregando…</p>

  const acabou = c.disponivel <= 0
  const cor = acabou ? 'var(--danger)' : c.pct >= 80 ? 'var(--warning)' : 'var(--primary)'
  return (
    <div>
      <div className="page-header"><h1>Assistente IA</h1></div>
      <p style={{ fontSize: 13.5, color: 'var(--text-muted)', margin: '-10px 0 18px' }}>
        O robô do canto da tela que responde sobre a sua loja. Cada pergunta que ele
        responde consome um pouquinho — aqui você acompanha quanto ainda dá pra usar.
      </p>

      <div style={{ ...caixa, borderColor: acabou ? 'var(--danger)' : 'var(--border)', position: 'relative' }}>
        {/* O "como funciona" é coisa que o dono lê UMA vez. Aberto na tela toda
            hora, vira parede de texto que ele pula — e aí some junto o aviso
            que importa (que usar o sistema não consome nada). */}
        <button type="button" onClick={() => setComoFunciona(v => !v)}
          aria-label="Como funciona a cobrança" title="Como funciona"
          style={{ ...S.ajuda, ...(comoFunciona ? S.ajudaAtiva : null) }}>
          ?
        </button>
        {/* Número em REAIS, não em "quantas perguntas": o custo depende do
            tamanho de cada pergunta, então qualquer contagem de perguntas seria
            um chute que o dono cobraria da gente depois. */}
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Ainda dá pra usar</div>
        <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1, color: cor }}>
          {acabou ? 'Acabou' : brl(c.disponivel)}
        </div>
        {!acabou && (
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
            em perguntas ao assistente
          </div>
        )}

        <div style={{ height: 8, borderRadius: 999, background: 'var(--border)', overflow: 'hidden', margin: '10px 0 8px' }}>
          <div style={{ height: '100%', width: `${c.pct}%`, background: cor, borderRadius: 999, transition: 'width 400ms' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-muted)', flexWrap: 'wrap', gap: 8 }}>
          <span>{brl(c.usado)} de {brl(c.franquia)} usados neste ciclo · {c.perguntas} perguntas</span>
          {c.saldo > 0 && <span>+ {brl(c.saldo)} de saldo comprado</span>}
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '12px 0 0' }}>
          Renova em {c.renovaEm ? dataBR(c.renovaEm) : '—'}, junto com a sua mensalidade.
        </p>

        {comoFunciona && (
          <div style={S.explicacao}>
            <strong style={{ fontSize: 13.5, display: 'block', marginBottom: 8 }}>Como funciona a cobrança</strong>
            <ul style={{ fontSize: 13, lineHeight: 1.65, margin: 0, paddingLeft: 18, color: 'var(--text-muted)' }}>
              <li>
                Cada pergunta é cobrada pelo tanto de informação que a inteligência artificial
                precisa ler e escrever pra te responder. <strong style={{ color: 'var(--text)' }}>Quanto
                mais dado ela tiver que levantar, mais aquela pergunta custa</strong> — perguntar
                o faturamento de hoje sai bem mais barato que comparar o ano inteiro.
              </li>
              <li>
                Esse valor vem da <strong style={{ color: 'var(--text)' }}>plataforma de inteligência
                artificial</strong> que responde, que cobra por uso. Não é uma mensalidade do
                sistema: você só paga quando pergunta.
              </li>
                <li>Sua mensalidade já inclui <strong style={{ color: 'var(--text)' }}>{brl(c.franquia)} por mês</strong> de assistente, contados do seu vencimento até o próximo.</li>
              <li>
                Acabou a franquia, sai do saldo comprado. Sem saldo, o robô descansa até
                a sua mensalidade renovar{c.renovaEm ? ` (${dataBR(c.renovaEm)})` : ''}.
              </li>
              <li>Ver seus números pelas telas do sistema <strong style={{ color: 'var(--text)' }}>não consome nada</strong> — o Dashboard e os Relatórios continuam liberados sempre.</li>
            </ul>
          </div>
        )}
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
        <h2 style={titulo}>O que você perguntou neste ciclo</h2>
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

const S = {
  ajuda: {
    position: 'absolute', top: 14, right: 14,
    width: 26, height: 26, borderRadius: '50%', cursor: 'pointer',
    border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text-muted)', fontSize: 14, fontWeight: 800,
    lineHeight: 1, fontFamily: 'inherit',
  },
  ajudaAtiva: {
    background: 'var(--primary)', color: 'var(--primary-contrast)',
    borderColor: 'var(--primary)',
  },
  explicacao: {
    marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)',
  },
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
