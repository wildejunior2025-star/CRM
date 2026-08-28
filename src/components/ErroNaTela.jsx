import { Component } from 'react'

// ── "A tela travou" que na verdade é só versão velha ────────────────────────
// Cada tela vive num pedaço de arquivo com nome próprio, e o nome muda a cada
// publicação. Quem estava com a aba aberta durante um deploy continua com o
// HTML antigo: ao abrir uma tela, ele pede um pedaço com o nome de antes. Se
// esse pedido não vira JavaScript, o React quebra lá dentro e a pessoa vê um
// texto que não diz nada — foi o que a Estação recebeu em 28/08/2026, no
// minuto exato de uma publicação: "undefined is not an object (evaluating
// 'e._result.default')" (o `_result` é a tripa do React.lazy).
//
// Isso não é defeito nem problema da pessoa: recarregar resolve sempre, porque
// traz o HTML novo com os nomes certos. Então a gente recarrega sozinho, uma
// vez — e só mostra mensagem se, mesmo assim, continuar quebrando.
const SINAIS_DE_VERSAO_VELHA = [
  '_result',                                  // React.lazy: o pedaço não chegou
  '_payload',
  'dynamically imported module',              // Chrome/Firefox
  'importing a module script failed',         // Safari / iPhone
  'unable to preload css',
  'is not a valid javascript mime type',      // veio HTML no lugar do JS
  "unexpected token '<'",                     // idem, em outro navegador
]

function ehVersaoVelha(erro) {
  const m = String(erro?.message ?? erro ?? '').toLowerCase()
  return SINAIS_DE_VERSAO_VELHA.some(s => m.includes(s))
}

// Mesma chave do main.jsx de propósito: os dois mecanismos recarregam pelo
// mesmo motivo, e compartilhar a trava impede que um chame o outro em laço.
const CHAVE_RELOAD = 'fwc_reload_pedaco'
const JANELA_MS = 20_000

function jaRecarregouAgora() {
  try {
    return Date.now() - Number(sessionStorage.getItem(CHAVE_RELOAD) || 0) < JANELA_MS
  } catch {
    return false   // navegador sem sessionStorage: melhor recarregar do que travar
  }
}

function marcarRecarga() {
  try { sessionStorage.setItem(CHAVE_RELOAD, String(Date.now())) } catch { /* ignora */ }
}

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

    // Versão velha na aba: recarregar resolve. Faz sozinho, uma vez só — se
    // já recarregou faz pouco e quebrou de novo, é outra coisa, aí mostra.
    if (ehVersaoVelha(erro) && !jaRecarregouAgora()) {
      marcarRecarga()
      window.location.reload()
    }
  }

  render() {
    if (!this.state.erro) return this.props.children

    const msg = String(this.state.erro?.message || this.state.erro || 'erro desconhecido')

    // Chegou aqui com cara de versão velha = o recarregar automático já foi
    // tentado e não resolveu. Ainda assim, pra pessoa na loja, o caminho é o
    // mesmo — e a mensagem técnica só assusta.
    if (ehVersaoVelha(this.state.erro)) {
      return (
        <div style={{
          minHeight: '100vh', padding: 20, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 14, textAlign: 'center',
          background: 'var(--bg, #0f172a)', color: 'var(--text, #f1f5f9)',
          font: '400 14px/1.55 system-ui, -apple-system, sans-serif',
        }}>
          <div style={{ fontSize: 34 }}>🔄</div>
          <strong style={{ fontSize: 17 }}>O sistema foi atualizado</strong>
          <p style={{ margin: 0, maxWidth: 420, color: 'var(--text-muted, #94a3b8)' }}>
            Saiu uma versão nova enquanto esta tela estava aberta. Não foi você e
            não se perdeu nada — é só recarregar pra pegar a versão nova.
          </p>
          <button type="button" onClick={() => { marcarRecarga(); window.location.reload() }} style={{
            padding: '11px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: '#7c3aed', color: '#fff', fontWeight: 800, fontSize: 14,
          }}>
            Recarregar
          </button>
        </div>
      )
    }
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
