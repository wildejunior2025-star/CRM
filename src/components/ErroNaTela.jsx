import { Component } from 'react'

// Tela branca é o pior jeito de falhar: a pessoa não sabe se travou, se a
// internet caiu ou se ela fez algo errado — e quem for consertar não recebe
// nenhuma pista. Já custou caro aqui mais de uma vez (o caso do garçom em
// 23/08/2026 foi o último: carregava e apagava, sem nenhuma mensagem).
//
// Aqui, quando uma tela quebra, aparece o que quebrou e um botão de recarregar.
// Não conserta o defeito — só troca o silêncio por uma pista.
export default class ErroNaTela extends Component {
  constructor(props) {
    super(props)
    this.state = { erro: null }
  }

  static getDerivedStateFromError(erro) {
    return { erro }
  }

  componentDidCatch(erro, info) {
    // Fica no console pra quem abrir o inspetor; a tela mostra o resumo.
    console.error('Tela quebrou:', erro, info?.componentStack)
  }

  render() {
    if (!this.state.erro) return this.props.children

    const msg = String(this.state.erro?.message || this.state.erro || 'erro desconhecido')
    return (
      <div style={{
        minHeight: '100vh', padding: 20, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 14, textAlign: 'center',
        background: 'var(--bg, #0f172a)', color: 'var(--text, #f1f5f9)',
        font: '400 14px/1.55 system-ui, -apple-system, sans-serif',
      }}>
        <div style={{ fontSize: 34 }}>😕</div>
        <strong style={{ fontSize: 17 }}>Esta tela travou</strong>
        <p style={{ margin: 0, maxWidth: 420, color: 'var(--text-muted, #94a3b8)' }}>
          Não foi você — deu erro no sistema. Recarregue; se acontecer de novo,
          mande esta mensagem pro suporte:
        </p>
        <code style={{
          maxWidth: '100%', overflowX: 'auto', padding: '10px 12px', borderRadius: 8,
          background: 'rgba(239,68,68,.12)', border: '1px solid rgba(239,68,68,.4)',
          color: '#fca5a5', fontSize: 12.5, textAlign: 'left', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{msg}</code>
        <button type="button" onClick={() => window.location.reload()} style={{
          padding: '11px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
          background: '#7c3aed', color: '#fff', fontWeight: 800, fontSize: 14,
        }}>
          Recarregar
        </button>
      </div>
    )
  }
}
