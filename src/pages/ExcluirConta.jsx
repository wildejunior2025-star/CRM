import { useEffect } from 'react'
import { Link } from 'react-router-dom'

const s = {
  page: { maxWidth: 720, margin: '0 auto', padding: '48px 24px 80px', fontFamily: "'Segoe UI', Arial, sans-serif", color: '#1a1a2e', lineHeight: 1.75, fontSize: 15 },
  logoText: { fontSize: 22, fontWeight: 800, color: '#6c2bd9', marginBottom: 24, display: 'block' },
  back: { color: '#6c2bd9', fontWeight: 600, textDecoration: 'none', display: 'inline-block', marginBottom: 20 },
  h1: { fontSize: 28, fontWeight: 800, color: '#1a1a2e', margin: '0 0 8px' },
  h2: { fontSize: 18, fontWeight: 700, color: '#6c2bd9', margin: '26px 0 8px' },
  p: { margin: '8px 0' },
  card: { background: '#f5f0ff', border: '1.5px solid #d6c7ff', borderRadius: 14, padding: '18px 20px', margin: '18px 0' },
  ul: { margin: '8px 0 8px 22px' },
  a: { color: '#6c2bd9', fontWeight: 600 },
  muted: { color: '#888', fontSize: 13, marginTop: 32 },
}

export default function ExcluirConta() {
  useEffect(() => {
    window.scrollTo(0, 0)
    document.title = 'Excluir conta — FWC Inter'
  }, [])

  return (
    <div style={s.page}>
      <span style={s.logoText}>FWC Inter</span>
      <Link to="/" style={s.back}>← Voltar</Link>

      <h1 style={s.h1}>Excluir sua conta e seus dados</h1>
      <p style={s.p}>
        Esta página explica como solicitar a exclusão da sua conta do aplicativo <strong>FWC Inter</strong> e
        dos dados associados a ela.
      </p>

      <div style={s.card}>
        <h2 style={{ ...s.h2, marginTop: 0 }}>Como pedir a exclusão</h2>
        <p style={s.p}>Envie uma solicitação por um dos canais abaixo, informando o <strong>e-mail cadastrado</strong> na conta:</p>
        <ul style={s.ul}>
          <li>📧 E-mail: <a style={s.a} href="mailto:wildejunior2025@gmail.com?subject=Excluir%20minha%20conta%20FWC%20Inter">wildejunior2025@gmail.com</a></li>
          <li>💬 WhatsApp: <a style={s.a} href="https://wa.me/5584999281009?text=Quero%20excluir%20minha%20conta%20FWC%20Inter">(84) 99928-1009</a></li>
        </ul>
        <p style={s.p}>Assunto/mensagem: <strong>"Excluir minha conta FWC Inter"</strong>.</p>
      </div>

      <h2 style={s.h2}>O que é excluído</h2>
      <ul style={s.ul}>
        <li>Seu cadastro (nome, e-mail, telefone, endereço)</li>
        <li>Seu login de acesso ao app</li>
        <li>Seus pontos, cashback e dados de indicação</li>
      </ul>

      <h2 style={s.h2}>O que pode ser mantido</h2>
      <p style={s.p}>
        Registros de pedidos e informações de pagamento podem ser mantidos pelo período exigido por obrigações
        legais e fiscais (em geral até 5 anos), de forma desvinculada da sua identidade sempre que possível.
        Após esse prazo, são eliminados.
      </p>

      <h2 style={s.h2}>Prazo</h2>
      <p style={s.p}>A exclusão é concluída em até <strong>7 dias</strong> após a solicitação.</p>

      <p style={s.muted}>
        FWC INTERMEDIAÇÕES LTDA — CNPJ 66.437.917/0001-66 · <Link to="/privacidade" style={s.a}>Política de Privacidade</Link>
      </p>
    </div>
  )
}
