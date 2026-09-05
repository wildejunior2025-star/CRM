// Rota que não existe (mig — sem migração, é só tela).
//
// Antes, endereço desconhecido dava TELA PRETA: o React não achava rota nenhuma
// e não desenhava nada. Quem abria via uma página vazia e não tinha o que fazer.
//
// E o caso mais comum disso não é link errado — é APARELHO COM VERSÃO VELHA. O
// service worker guarda o app de quando a pessoa entrou pela primeira vez; se a
// rota nasceu depois, a casca antiga não a conhece. Foi o que aconteceu com o
// link de confirmar o ponto no mapa: abria em branco e só aparecia depois de dar
// F5 — e ninguém vai pedir isso pro cliente.
//
// A rota já foi tirada do cache do service worker, então não deve mais cair
// aqui por esse motivo. Esta tela é a rede embaixo da rede: se cair, ela explica
// e oferece o botão que resolve.
export default function PaginaNaoEncontrada() {
  async function recarregarDeVerdade() {
    // Recarregar normal pode servir a mesma casca velha de novo. Aqui a gente
    // desmonta o service worker e limpa os caches antes — é o "abrir pela
    // primeira vez" que conserta o caso de aparelho desatualizado.
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.()
      await Promise.all((regs ?? []).map(r => r.unregister()))
      const nomes = await caches?.keys?.()
      await Promise.all((nomes ?? []).map(n => caches.delete(n)))
    } catch { /* navegador sem isso: o reload abaixo ainda ajuda */ }
    window.location.reload()
  }

  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24,
      textAlign: 'center', background: '#0f1115', color: '#f3f4f6',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    }}>
      <div style={{ fontSize: 52 }}>🔄</div>
      <h1 style={{ fontSize: 20, margin: 0 }}>Não consegui abrir esta página</h1>
      <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: '#9aa1ad', maxWidth: 330 }}>
        Pode ser que o seu aparelho esteja com uma versão antiga guardada.
        Toque no botão abaixo que eu busco a versão nova.
      </p>
      <button
        type="button" onClick={recarregarDeVerdade}
        style={{
          marginTop: 4, padding: '13px 22px', borderRadius: 10, border: 'none',
          background: '#863bff', color: '#fff', fontSize: 15, fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        Buscar a versão nova
      </button>
      <a href="/" style={{ fontSize: 13, color: '#9aa1ad', marginTop: 2 }}>Ir para o início</a>
    </div>
  )
}
