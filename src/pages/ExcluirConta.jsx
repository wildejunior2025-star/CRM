import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'

const s = {
  page: { maxWidth: 720, margin: '0 auto', padding: '48px 24px 80px', fontFamily: "'Segoe UI', Arial, sans-serif", color: '#1a1a2e', lineHeight: 1.75, fontSize: 15 },
  logoText: { fontSize: 22, fontWeight: 800, color: '#6c2bd9', marginBottom: 24, display: 'block' },
  back: { color: '#6c2bd9', fontWeight: 600, textDecoration: 'none', display: 'inline-block', marginBottom: 20 },
  h1: { fontSize: 28, fontWeight: 800, color: '#1a1a2e', margin: '0 0 8px' },
  h2: { fontSize: 18, fontWeight: 700, color: '#6c2bd9', margin: '26px 0 8px' },
  p: { margin: '8px 0' },
  card: { background: '#f5f0ff', border: '1.5px solid #d6c7ff', borderRadius: 14, padding: '18px 20px', margin: '18px 0' },
  cardAlerta: { background: '#fff4f4', border: '1.5px solid #f3b5b5', borderRadius: 14, padding: '18px 20px', margin: '18px 0' },
  ul: { margin: '8px 0 8px 22px' },
  a: { color: '#6c2bd9', fontWeight: 600 },
  muted: { color: '#888', fontSize: 13, marginTop: 32 },
  btnPerigo: { background: '#dc2626', color: '#fff', border: 0, borderRadius: 10, padding: '12px 20px', fontSize: 15, fontWeight: 700, cursor: 'pointer', marginTop: 8 },
  btnNeutro: { background: '#fff', color: '#1a1a2e', border: '1.5px solid #d6c7ff', borderRadius: 10, padding: '12px 20px', fontSize: 15, fontWeight: 700, cursor: 'pointer', marginTop: 8, marginLeft: 8 },
  btnPrimario: { background: '#6c2bd9', color: '#fff', border: 0, borderRadius: 10, padding: '12px 20px', fontSize: 15, fontWeight: 700, cursor: 'pointer', marginTop: 8, textDecoration: 'none', display: 'inline-block' },
  erro: { color: '#dc2626', fontWeight: 600, marginTop: 8 },
}

const dataBR = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })

// Exclusão de conta DENTRO do app (exigência da Apple, regra 5.1.1). O cliente
// agenda, tem 30 dias pra desistir e depois o banco apaga sozinho (mig 0357).
// Conta de equipe de loja não se exclui por aqui: derrubaria a loja.
export default function ExcluirConta() {
  const [estado, setEstado] = useState('carregando') // carregando | deslogado | equipe | cliente
  const [pedido, setPedido] = useState(null)          // linha de contas_exclusao ativa
  const [confirmando, setConfirmando] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    window.scrollTo(0, 0)
    document.title = 'Excluir conta — FWC Inter'
    carregar()
  }, [])

  async function carregar() {
    const { data: { session } } = await supabase.auth.getSession()
    const uid = session?.user?.id
    if (!uid) { setEstado('deslogado'); return }
    const [{ data: perfil }, { data: exc }] = await Promise.all([
      supabase.from('profiles').select('perfil').eq('id', uid).maybeSingle(),
      supabase.from('contas_exclusao').select('apagar_em, cancelado_em, concluido_em').eq('user_id', uid).maybeSingle(),
    ])
    if ((perfil?.perfil || 'cliente') !== 'cliente') { setEstado('equipe'); return }
    setPedido(exc && !exc.cancelado_em && !exc.concluido_em ? exc : null)
    setEstado('cliente')
  }

  async function excluir() {
    setOcupado(true); setErro(null)
    const { error } = await supabase.rpc('pedir_exclusao_conta')
    setOcupado(false); setConfirmando(false)
    if (error) { setErro(error.message); return }
    await carregar()
  }

  async function cancelar() {
    setOcupado(true); setErro(null)
    const { error } = await supabase.rpc('cancelar_exclusao_conta')
    setOcupado(false)
    if (error) { setErro(error.message); return }
    await carregar()
  }

  return (
    <div style={s.page}>
      <span style={s.logoText}>FWC Inter</span>
      <Link to="/" style={s.back}>← Voltar</Link>

      <h1 style={s.h1}>Excluir sua conta e seus dados</h1>

      {estado === 'cliente' && !pedido && (
        <div style={s.cardAlerta}>
          <h2 style={{ ...s.h2, marginTop: 0, color: '#dc2626' }}>Excluir minha conta</h2>
          <p style={s.p}>
            Sua conta fica marcada pra exclusão e é <strong>apagada de vez em 30 dias</strong>. Até lá você pode
            entrar no app e cancelar.
          </p>
          {!confirmando ? (
            <button type="button" style={s.btnPerigo} onClick={() => setConfirmando(true)}>Excluir minha conta</button>
          ) : (
            <>
              <p style={{ ...s.p, fontWeight: 600 }}>Tem certeza? Depois dos 30 dias não dá pra recuperar.</p>
              <button type="button" style={s.btnPerigo} disabled={ocupado} onClick={excluir}>
                {ocupado ? 'Excluindo…' : 'Sim, excluir'}
              </button>
              <button type="button" style={s.btnNeutro} disabled={ocupado} onClick={() => setConfirmando(false)}>Voltar</button>
            </>
          )}
          {erro && <p style={s.erro}>{erro}</p>}
        </div>
      )}

      {estado === 'cliente' && pedido && (
        <div style={s.cardAlerta}>
          <h2 style={{ ...s.h2, marginTop: 0, color: '#dc2626' }}>Exclusão agendada</h2>
          <p style={s.p}>
            Sua conta e seus dados serão apagados em <strong>{dataBR(pedido.apagar_em)}</strong>.
            Se mudou de ideia, cancele antes dessa data.
          </p>
          <button type="button" style={s.btnPrimario} disabled={ocupado} onClick={cancelar}>
            {ocupado ? 'Cancelando…' : 'Cancelar exclusão'}
          </button>
          {erro && <p style={s.erro}>{erro}</p>}
        </div>
      )}

      {estado === 'deslogado' && (
        <div style={s.card}>
          <h2 style={{ ...s.h2, marginTop: 0 }}>Como excluir</h2>
          <p style={s.p}>Entre na sua conta e volte nesta página (Perfil → <strong>Excluir minha conta</strong>).</p>
          <Link to="/login?tipo=cliente" style={s.btnPrimario}>Entrar na minha conta</Link>
          <p style={{ ...s.p, marginTop: 16 }}>
            Não consegue entrar? Peça pelo e-mail <a style={s.a} href="mailto:contato@fwcinter.com?subject=Excluir%20minha%20conta%20FWC%20Inter">contato@fwcinter.com</a> ou
            pelo WhatsApp <a style={s.a} href="https://wa.me/5584999120349?text=Quero%20excluir%20minha%20conta%20FWC%20Inter">(84) 99912-0349</a>, informando o e-mail da conta.
          </p>
        </div>
      )}

      {estado === 'equipe' && (
        <div style={s.card}>
          <h2 style={{ ...s.h2, marginTop: 0 }}>Conta de loja</h2>
          <p style={s.p}>
            Contas de dono e funcionários de loja (FWC Gestor) são excluídas pela FWC, pra não derrubar a operação da
            loja por engano. Peça pelo e-mail <a style={s.a} href="mailto:contato@fwcinter.com?subject=Excluir%20conta%20de%20loja">contato@fwcinter.com</a> ou
            pelo WhatsApp <a style={s.a} href="https://wa.me/5584999120349?text=Quero%20excluir%20minha%20conta%20de%20loja">(84) 99912-0349</a>.
          </p>
        </div>
      )}

      <h2 style={s.h2}>O que é excluído</h2>
      <ul style={s.ul}>
        <li>Seu login de acesso ao app</li>
        <li>Seu perfil (nome, e-mail, telefone, endereço)</li>
        <li>Seus pontos, cashback e dados de indicação</li>
        <li>Seu nome, telefone, e-mail, CPF e endereço no cadastro de cada loja onde você comprou</li>
      </ul>

      <h2 style={s.h2}>O que fica, sem identificar você</h2>
      <p style={s.p}>
        Os pedidos e valores continuam no histórico das lojas como <strong>"Cliente excluído"</strong>, sem nenhum dado
        pessoal, porque fazem parte do caixa e das obrigações fiscais delas.
      </p>

      <h2 style={s.h2}>Prazo</h2>
      <p style={s.p}>A exclusão é concluída <strong>30 dias</strong> depois do pedido. Nesse prazo você pode cancelar.</p>

      <p style={s.muted}>
        FWC INTERMEDIAÇÕES LTDA — CNPJ 66.437.917/0001-66 · <Link to="/privacidade" style={s.a}>Política de Privacidade</Link>
      </p>
    </div>
  )
}
