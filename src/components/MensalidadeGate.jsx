import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { carregarExcecoes } from '../lib/feriados'
import { faseDaMensalidade, diasAteTravar, dataCurtaBR, somaDiasYmd, periodoTexto } from '../lib/mensalidade'
import MensalidadePagamento from './MensalidadePagamento'

// Mensalidade atrasada (migs 0263/0264) — decidido com o Wilde em 13/09/2026:
//   - só o ADMINISTRADOR vê aviso e pop-up; funcionário não vê valor nenhum
//   - dia do vencimento e carência: aviso no canto, sem travar
//   - dia de travar, a partir da abertura: pop-up fixo pro admin (só sai
//     pagando) e tela de "acesso suspenso" pro funcionário
//   - pedido, iFood, Loja Online e robô continuam funcionando por trás

const PUBLICAS = ['/login', '/cadastro', '/reset-password', '/entrar', '/termos', '/privacidade', '/excluir-conta',
  '/lojas', '/loja/', '/checkout', '/pedido/', '/mesa/', '/c/', '/ver/', '/meus-pedidos', '/super-admin']
const FUNCIONARIOS = ['garcom', 'cozinheiro', 'entregador', 'vendedor']

export default function MensalidadeGate() {
  const { profile, empresa, voltarSuperAdmin } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [situacao, setSituacao] = useState(null)
  const [excecoes, setExcecoes] = useState({})
  const [relogio, setRelogio] = useState(() => Date.now())
  const [avisoFechado, setAvisoFechado] = useState(false)
  const [pagarAberto, setPagarAberto] = useState(false)

  const perfil = profile?.perfil
  const admin = perfil === 'admin'
  const participa = !!empresa?.id && (admin || FUNCIONARIOS.includes(perfil))
  const publica = PUBLICAS.some(p => pathname.startsWith(p))
  const impersonando = typeof localStorage !== 'undefined' && !!localStorage.getItem('crm_superadmin_backup')

  const carregar = useCallback(async () => {
    if (!participa) { setSituacao(null); return }
    const { data } = await supabase.rpc('mensalidade_situacao')
    setSituacao(data ?? null)
    if (data?.mais_antiga_vencida) {
      setExcecoes(await carregarExcecoes(supabase, empresa.id, { de: data.mais_antiga_vencida, ate: somaDiasYmd(data.hoje, 45) }))
    }
    setRelogio(Date.now())
  }, [participa, empresa?.id])

  // Confere ao abrir, a cada 5 min (o pop-up entra na hora da abertura mesmo
  // com a tela aberta desde antes) e quando a aba volta a ficar visível.
  useEffect(() => {
    carregar()
    const id = setInterval(carregar, 5 * 60 * 1000)
    const onVis = () => { if (document.visibilityState === 'visible') carregar() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [carregar])

  const loja = useMemo(() => ({
    grade: empresa?.horarios_funcionamento, excecoes, fechaFeriado: !!empresa?.feriados_fecha,
  }), [empresa?.horarios_funcionamento, empresa?.feriados_fecha, excecoes])

  // relogio entra de propósito: refaz a conta a cada recarga.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const estado = useMemo(() => faseDaMensalidade(situacao, loja, new Date()), [situacao, loja, relogio])

  // Prova de aviso: registra o que a pessoa viu (uma vez por dia no banco).
  useEffect(() => {
    if (!situacao?.ativa || publica) return
    const cobranca = situacao.abertas?.find(c => c.vencimento === estado.vencimento)?.id ?? null
    let tipo = null
    if (estado.travaAgora) tipo = admin ? 'popup' : 'bloqueio_funcionario'
    else if (admin && estado.fase === 'vence_hoje') tipo = 'faixa_vence_hoje'
    else if (admin && (estado.fase === 'carencia' || estado.fase === 'prazo')) tipo = 'faixa_carencia'
    // O .then() é o que dispara: sem ele o supabase-js monta a chamada e não envia.
    if (tipo) supabase.rpc('mensalidade_registrar_aviso', { p_tipo: tipo, p_cobranca: cobranca, p_detalhe: `fase ${estado.fase}; trava ${estado.diaBloqueio ?? '-'}` }).then(() => {})
  }, [situacao, estado.fase, estado.travaAgora, estado.vencimento, estado.diaBloqueio, admin, publica])

  if (!participa || publica || !situacao?.ativa) return null

  // ── Termo aceito uma vez (só admin) ────────────────────────────────────────
  if (admin && !situacao.termo_aceito_em) {
    return (
      <Tela>
        <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 10 }}>📋 Como funciona a mensalidade</div>
        <ul style={{ fontSize: 14.5, lineHeight: 1.6, paddingLeft: 18, margin: '0 0 16px' }}>
          <li>Valor: <strong>{Number(situacao.valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</strong> por {periodoTexto(situacao.periodicidade)}{situacao.periodicidade === 'quinzenal' ? ' (vence dia 1 e dia 15)' : ''}.</li>
          <li>No dia do vencimento aparece um aviso aqui no sistema, e a FWC avisa no WhatsApp.</li>
          <li>Depois do vencimento, a loja tem <strong>{situacao.carencia_dias} dia(s) de funcionamento</strong> pra pagar.</li>
          <li>Passado esse prazo, na abertura do dia seguinte o sistema fica <strong>bloqueado por um aviso de pagamento</strong> até pagar, e os funcionários ficam sem acesso. Pedidos, iFood, Loja Online e robô continuam chegando.</li>
          <li>Dá pra pagar no PIX ou deixar no cartão, cobrando sozinho.</li>
        </ul>
        <button type="button" style={botao} onClick={async () => { await supabase.rpc('mensalidade_aceitar_termo'); carregar() }}>
          Li e concordo
        </button>
      </Tela>
    )
  }

  // ── Funcionário: sem acesso quando trava ──────────────────────────────────
  if (!admin) {
    if (!estado.travaAgora) return null
    return (
      <Tela>
        <div style={{ fontSize: 48, textAlign: 'center' }}>🔒</div>
        <div style={{ fontSize: 21, fontWeight: 900, textAlign: 'center', margin: '8px 0' }}>Acesso suspenso</div>
        <div style={{ fontSize: 15, textAlign: 'center', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          O sistema de <strong style={{ color: 'var(--text)' }}>{empresa?.nome}</strong> está com uma pendência.
          Avise o responsável pela loja. Assim que for resolvido, o acesso volta sozinho.
        </div>
        <button type="button" style={{ ...botao, marginTop: 18 }} onClick={carregar}>Já resolveram? Tentar de novo</button>
      </Tela>
    )
  }

  // ── Admin: pop-up fixo ─────────────────────────────────────────────────────
  if (estado.travaAgora) {
    return (
      <Tela>
        <div style={{ fontSize: 21, fontWeight: 900 }}>⚠️ Mensalidade em atraso</div>
        <div style={{ fontSize: 13.5, color: 'var(--text-muted)', margin: '4px 0 14px', lineHeight: 1.45 }}>
          O acesso fica bloqueado até o pagamento. Os pedidos continuam chegando, mas os funcionários estão sem acesso.
        </div>
        <MensalidadePagamento situacao={situacao} empresaId={empresa?.id} onPago={carregar} />
        {/* Sem "Já paguei": o Wilde tirou (13/09) — o PIX libera sozinho, e o botão
            dava 1 hora livre por dia pra quem não pagou. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          <a href="https://wa.me/5584999120349" target="_blank" rel="noreferrer" style={linkBotao}>Falar com a FWC</a>
          {impersonando && (
            <button type="button" style={linkBotao} onClick={async () => { await voltarSuperAdmin(); navigate('/super-admin') }}>← Voltar ao Super Admin</button>
          )}
        </div>
      </Tela>
    )
  }

  // ── Admin: pagar pelo aviso, sem sair da tela onde está ────────────────────
  if (pagarAberto) {
    return (
      <Tela>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 19, fontWeight: 900 }}>🧾 Mensalidade</div>
          <button type="button" aria-label="Fechar" onClick={() => setPagarAberto(false)}
            style={{ background: 'none', border: 'none', color: 'var(--text)', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <MensalidadePagamento situacao={situacao} empresaId={empresa?.id} onPago={() => { setPagarAberto(false); carregar() }} />
      </Tela>
    )
  }

  // ── Admin: aviso no canto (vence hoje / carência / prazo) ──────────────────
  if (avisoFechado || !['vence_hoje', 'carencia', 'prazo'].includes(estado.fase)) return null
  const faltam = estado.diaBloqueio ? diasAteTravar(situacao.hoje, estado.diaBloqueio, loja) : null
  const total = (situacao.abertas ?? []).filter(c => c.vencimento <= situacao.hoje).reduce((s, c) => s + Number(c.valor), 0)
  const texto = estado.fase === 'vence_hoje'
    ? `A mensalidade vence hoje (${total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}).`
    : estado.fase === 'prazo'
      ? `Mensalidade em atraso — prazo combinado até ${dataCurtaBR(situacao.prazo_ate)}.`
      : `Mensalidade atrasada. O sistema será bloqueado na abertura de ${dataCurtaBR(estado.diaBloqueio)}${faltam ? ` (faltam ${faltam} dia${faltam > 1 ? 's' : ''} de funcionamento)` : ''}.`
  const vermelho = estado.fase !== 'vence_hoje'
  // No computador o aviso ficava pequeno demais no canto da tela grande.
  const pc = typeof window !== 'undefined' && window.innerWidth >= 900
  return (
    <div role="alert" style={{
      position: 'fixed', right: pc ? 24 : 16, bottom: pc ? 24 : 16, zIndex: 9000,
      maxWidth: pc ? 480 : 'min(380px, calc(100vw - 32px))',
      background: vermelho ? '#b91c1c' : '#b45309', color: '#fff', borderRadius: pc ? 18 : 14,
      padding: pc ? '18px 20px' : '12px 14px',
      boxShadow: '0 14px 40px rgba(0,0,0,.4)', fontSize: pc ? 16.5 : 13.5, lineHeight: 1.4,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <strong>{vermelho ? '⚠️' : '🧾'} {texto}</strong>
        <button type="button" aria-label="Fechar aviso" onClick={() => setAvisoFechado(true)}
          style={{ background: 'none', border: 'none', color: '#fff', fontSize: pc ? 24 : 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
      </div>
      <button type="button" onClick={() => setPagarAberto(true)} style={{
        marginTop: pc ? 14 : 8, background: '#fff', color: vermelho ? '#b91c1c' : '#b45309', border: 'none', borderRadius: 10,
        padding: pc ? '11px 22px' : '7px 12px', fontSize: pc ? 15.5 : 13.5, fontWeight: 800, cursor: 'pointer',
      }}>Pagar agora</button>
    </div>
  )
}

function Tela({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(8,8,16,.78)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflowY: 'auto',
    }}>
      <div style={{
        width: '100%', maxWidth: 460, maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
        background: 'var(--surface, #1a1a2e)', color: 'var(--text, #eee)', borderRadius: 18, padding: '20px 18px',
        border: '1px solid var(--border, #2a2a3a)', boxShadow: '0 20px 60px rgba(0,0,0,.5)',
      }}>
        {children}
      </div>
    </div>
  )
}

const botao = {
  width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
  background: 'var(--primary)', color: '#fff', fontWeight: 800, fontSize: 15,
}
const linkBotao = {
  background: 'none', border: 'none', color: 'var(--primary, #a78bfa)', fontWeight: 700, fontSize: 13,
  cursor: 'pointer', padding: 0, textDecoration: 'none',
}
