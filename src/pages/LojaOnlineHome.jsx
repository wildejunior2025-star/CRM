// Página neutra do domínio lojaonline quando não há loja no link.
// Não lista outras lojas — cada cliente só acessa a loja pelo link dela.
export default function LojaOnlineHome() {
  return (
    <div style={{
      minHeight: '100vh', background: '#0f0f1a', color: '#fff',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', padding: 24,
    }}>
      <div style={{ fontWeight: 800, fontSize: 28, letterSpacing: 1, marginBottom: 16 }}>FWC</div>
      <div style={{ fontSize: 40, marginBottom: 12 }}>🛒</div>
      <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Abra o link da sua loja</h1>
      <p style={{ color: '#94a3b8', maxWidth: 340, lineHeight: 1.5, fontSize: 14 }}>
        Para fazer um pedido, use o link que a loja te enviou. Cada loja tem o
        seu próprio endereço.
      </p>
    </div>
  )
}
