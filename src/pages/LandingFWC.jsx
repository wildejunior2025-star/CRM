import { Link } from 'react-router-dom'
import logoFwc from '../assets/logo-fwc-icone.png'
import './LandingFWC.css'

// Número do WhatsApp de contato (só dígitos, com DDI 55). Ajuste se mudar.
const WHATSAPP = '5584999281009'
const WHATSAPP_MSG = encodeURIComponent('Olá! Quero conhecer o sistema FWC Inter para a minha loja.')
const waLink = `https://wa.me/${WHATSAPP}?text=${WHATSAPP_MSG}`

// Recursos exibidos na grade — ícone (emoji), título e descrição.
const RECURSOS = [
  { icone: '🛵', titulo: 'Delivery próprio', desc: 'Receba pedidos online com sua taxa, raio de entrega e tempo de preparo — sem comissão de marketplace.' },
  { icone: '🍔', titulo: 'Integração iFood', desc: 'Os pedidos do iFood caem direto no seu painel, junto com os outros. Confirme, despache e cancele sem trocar de tela.', novo: true },
  { icone: '🏪', titulo: 'Loja online', desc: 'Sua vitrine pública com link próprio (lojaonline.fwcinter.com/sualoja). O cliente vê o catálogo e pede sem instalar nada.' },
  { icone: '📱', titulo: 'App do cliente', desc: 'Seu cliente acompanha o pedido, junta pontos de fidelidade e vê o fiado dele pelo aplicativo.' },
  { icone: '🖥️', titulo: 'Gestor de pedidos', desc: 'Painel com som de pedido novo, colunas por etapa (na cozinha, pronto, em rota), impressão de cupom e tudo em tempo real.' },
  { icone: '🛵', titulo: 'Painel do entregador', desc: 'O motoboy aceita a entrega, vê a rota, liga pro cliente e confirma a entrega com código — tudo no celular.' },
  { icone: '🍽️', titulo: 'Atendimento no salão', desc: 'Mesas, comandas, QR code de autoatendimento, tela da cozinha e do garçom. Feche a conta dividida em segundos.' },
  { icone: '💬', titulo: 'Bot de WhatsApp', desc: 'Atendimento e pedidos pelo WhatsApp com inteligência artificial, 24h, sem você precisar responder na mão.' },
  { icone: '💳', titulo: 'Fiado e financeiro', desc: 'Controle o crédito de cada cliente, registre recebimentos e cobre pelo WhatsApp com um clique.' },
  { icone: '📦', titulo: 'Produtos e estoque', desc: 'Cadastro com foto, controle de estoque, movimentações e até cascos por cliente.' },
  { icone: '🧾', titulo: 'PDV, vendas e caixa', desc: 'Venda no balcão, abertura e fechamento de caixa, sangrias e histórico completo do turno.' },
  { icone: '📊', titulo: 'Relatórios', desc: 'Faturamento, ranking de produtos, canais de venda e resumo diário no seu WhatsApp.' },
]

export default function LandingFWC() {
  return (
    <div className="lp">
      {/* Barra de topo */}
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <div className="lp-brand">
            <img src={logoFwc} alt="FWC Inter" className="lp-logo" />
            <span className="lp-brand-name">FWC Inter</span>
          </div>
          <div className="lp-nav-actions">
            <a href={waLink} target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-ghost lp-hide-sm">
              WhatsApp
            </a>
            <Link to="/login" className="lp-btn lp-btn-ghost">Entrar</Link>
            <Link to="/cadastro" className="lp-btn lp-btn-solid">Começar grátis</Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero-inner">
          <span className="lp-badge">Sistema completo para o seu comércio</span>
          <h1 className="lp-hero-title">
            Tudo da sua loja num <span className="lp-grad">painel só</span>
          </h1>
          <p className="lp-hero-sub">
            Delivery próprio, iFood, loja online, app do cliente, salão, WhatsApp, fiado e
            financeiro. Pare de pular de sistema em sistema — o FWC Inter junta tudo num lugar.
          </p>
          <div className="lp-hero-cta">
            <Link to="/cadastro" className="lp-btn lp-btn-solid lp-btn-lg">Começar grátis</Link>
            <a href={waLink} target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-wa lp-btn-lg">
              <span aria-hidden="true">💬</span> Falar no WhatsApp
            </a>
          </div>
          <p className="lp-hero-nota">Sem cartão de crédito · Configure em minutos</p>
        </div>
      </section>

      {/* Faixa de destaque iFood */}
      <section className="lp-faixa">
        <div className="lp-faixa-inner">
          <span className="lp-faixa-tag">NOVO</span>
          <p>
            Agora com <strong>integração oficial ao iFood</strong>: os pedidos do iFood
            aparecem no mesmo painel dos seus pedidos, com confirmação e despacho automáticos.
          </p>
        </div>
      </section>

      {/* Recursos */}
      <section className="lp-recursos" id="recursos">
        <div className="lp-sec-head">
          <h2>Tudo que a sua loja precisa</h2>
          <p>Cada recurso pensado pra operação real do dia a dia — e tudo conversa entre si.</p>
        </div>
        <div className="lp-grid">
          {RECURSOS.map((r) => (
            <div className="lp-card" key={r.titulo}>
              {r.novo && <span className="lp-card-novo">NOVO</span>}
              <div className="lp-card-icone" aria-hidden="true">{r.icone}</div>
              <h3>{r.titulo}</h3>
              <p>{r.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Como funciona */}
      <section className="lp-passos">
        <div className="lp-sec-head">
          <h2>Comece em 3 passos</h2>
        </div>
        <div className="lp-passos-grid">
          <div className="lp-passo">
            <div className="lp-passo-num">1</div>
            <h3>Crie sua conta</h3>
            <p>Cadastre sua loja grátis em menos de 2 minutos.</p>
          </div>
          <div className="lp-passo">
            <div className="lp-passo-num">2</div>
            <h3>Monte seu catálogo</h3>
            <p>Adicione produtos, fotos e preços. Ative o delivery e a loja online.</p>
          </div>
          <div className="lp-passo">
            <div className="lp-passo-num">3</div>
            <h3>Receba pedidos</h3>
            <p>Do seu link, do WhatsApp e do iFood — todos no mesmo painel.</p>
          </div>
        </div>
      </section>

      {/* CTA final */}
      <section className="lp-cta">
        <div className="lp-cta-inner">
          <h2>Pronto pra organizar sua loja?</h2>
          <p>Comece grátis agora ou fale com a gente pra tirar suas dúvidas.</p>
          <div className="lp-hero-cta">
            <Link to="/cadastro" className="lp-btn lp-btn-solid lp-btn-lg">Começar grátis</Link>
            <a href={waLink} target="_blank" rel="noopener noreferrer" className="lp-btn lp-btn-wa lp-btn-lg">
              <span aria-hidden="true">💬</span> Falar no WhatsApp
            </a>
          </div>
        </div>
      </section>

      {/* Rodapé */}
      <footer className="lp-footer">
        <div className="lp-footer-inner">
          <div className="lp-brand">
            <img src={logoFwc} alt="FWC Inter" className="lp-logo" />
            <span className="lp-brand-name">FWC Inter</span>
          </div>
          <nav className="lp-footer-links">
            <Link to="/login">Entrar</Link>
            <Link to="/cadastro">Cadastrar loja</Link>
            <a href={waLink} target="_blank" rel="noopener noreferrer">WhatsApp</a>
            <Link to="/termos">Termos</Link>
            <Link to="/privacidade">Privacidade</Link>
          </nav>
          <p className="lp-copy">© {new Date().getFullYear()} FWC Inter · Todos os direitos reservados</p>
        </div>
      </footer>
    </div>
  )
}
