import { useEffect } from 'react'
import { Link } from 'react-router-dom'

const s = {
  page: {
    maxWidth: 860,
    margin: '0 auto',
    padding: '48px 24px 80px',
    fontFamily: "'Segoe UI', Arial, sans-serif",
    color: '#1a1a2e',
    lineHeight: 1.75,
    fontSize: 15,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 40,
  },
  logoText: {
    fontSize: 22,
    fontWeight: 700,
    color: '#6c2bd9',
  },
  h1: {
    fontSize: 28,
    fontWeight: 800,
    color: '#1a1a2e',
    marginBottom: 6,
  },
  updated: {
    fontSize: 13,
    color: '#888',
    marginBottom: 40,
  },
  intro: {
    background: '#f5f0ff',
    borderLeft: '4px solid #6c2bd9',
    padding: '16px 20px',
    borderRadius: '0 8px 8px 0',
    marginBottom: 40,
    fontSize: 14,
  },
  h2: {
    fontSize: 18,
    fontWeight: 700,
    color: '#6c2bd9',
    marginTop: 48,
    marginBottom: 12,
    borderBottom: '2px solid #ede9fe',
    paddingBottom: 8,
  },
  h3: {
    fontSize: 15,
    fontWeight: 700,
    color: '#1a1a2e',
    marginTop: 24,
    marginBottom: 8,
  },
  p: {
    marginBottom: 14,
  },
  ul: {
    paddingLeft: 24,
    marginBottom: 14,
  },
  li: {
    marginBottom: 6,
  },
  box: {
    background: '#fff8f0',
    border: '1px solid #fde8cc',
    borderRadius: 8,
    padding: '14px 18px',
    marginBottom: 14,
    fontSize: 14,
  },
  infoBox: {
    background: '#f0fff4',
    border: '1px solid #c6f6d5',
    borderRadius: 8,
    padding: '14px 18px',
    marginBottom: 14,
    fontSize: 14,
  },
  warnBox: {
    background: '#fffbeb',
    border: '1px solid #fde68a',
    borderRadius: 8,
    padding: '14px 18px',
    marginBottom: 14,
    fontSize: 14,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    marginBottom: 20,
    fontSize: 14,
  },
  th: {
    background: '#6c2bd9',
    color: '#fff',
    padding: '10px 14px',
    textAlign: 'left',
    fontWeight: 600,
  },
  td: {
    padding: '9px 14px',
    borderBottom: '1px solid #ede9fe',
    verticalAlign: 'top',
  },
  trEven: {
    background: '#f9f7ff',
  },
  footer: {
    marginTop: 60,
    padding: '24px',
    background: '#f5f0ff',
    borderRadius: 12,
    fontSize: 13,
    color: '#555',
  },
  backLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    color: '#6c2bd9',
    textDecoration: 'none',
    fontWeight: 600,
    marginBottom: 32,
    fontSize: 14,
  },
  tag: {
    display: 'inline-block',
    background: '#ede9fe',
    color: '#6c2bd9',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 12,
    fontWeight: 600,
    marginRight: 6,
    marginBottom: 4,
  },
}

export default function Privacidade() {
  useEffect(() => {
    window.scrollTo(0, 0)
    document.title = 'Política de Privacidade — FWC Inter'
  }, [])

  return (
    <div style={s.page}>
      <div style={s.logo}>
        <span style={s.logoText}>FWC Inter</span>
      </div>

      <Link to="/" style={s.backLink}>← Voltar</Link>

      <h1 style={s.h1}>Política de Privacidade</h1>
      <p style={s.updated}>Última atualização: 21 de junho de 2026</p>

      <div style={s.intro}>
        Esta Política de Privacidade descreve como a <strong>FWC INTERMEDIAÇÕES LTDA</strong> coleta, utiliza, armazena,
        compartilha e protege os dados pessoais dos usuários da Plataforma <strong>FWC Inter</strong>,
        em conformidade com a <strong>Lei Geral de Proteção de Dados — LGPD (Lei nº 13.709/2018)</strong> e demais
        normas aplicáveis da República Federativa do Brasil.
      </div>

      {/* ─── 1. CONTROLADOR ─── */}
      <h2 style={s.h2}>1. Quem Somos (Controlador dos Dados)</h2>
      <div style={s.box}>
        <strong>FWC INTERMEDIAÇÕES LTDA</strong> — Controladora dos Dados<br />
        CNPJ: 66.437.917/0001-66<br />
        Av. Nascimento de Castro, nº 81, Dix-Sept Rosado, Natal – RN, CEP: 59.054-180<br />
        E-mail DPO / Privacidade: <strong>franciscowildecjunior96@gmail.com</strong><br />
        Telefone: (84) 9818-0774
      </div>
      <p style={s.p}>
        A FWC é a responsável pelas decisões sobre o tratamento de dados pessoais coletados diretamente na Plataforma.
        Os Parceiros (lojas) que utilizam a Plataforma para gerir seus próprios clientes atuam como <em>operadores</em>
        sob responsabilidade de seus próprios termos e políticas.
      </p>

      {/* ─── 2. DADOS COLETADOS ─── */}
      <h2 style={s.h2}>2. Quais Dados Coletamos</h2>

      <h3 style={s.h3}>2.1. Clientes Finais (portal de delivery / pedidos)</h3>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Categoria</th>
            <th style={s.th}>Dados</th>
            <th style={s.th}>Obrigatório?</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Identificação', 'Nome completo, apelido (username), e-mail', 'Sim'],
            ['Contato', 'Número de telefone / WhatsApp', 'Sim'],
            ['Endereço', 'CEP, logradouro, número, complemento, bairro, cidade, estado', 'Sim (para entrega)'],
            ['Fiscal (opcional)', 'CPF ou CNPJ', 'Não'],
            ['Autenticação Google', 'Nome, e-mail, foto de perfil (via Google OAuth)', 'Quando usar login Google'],
            ['Indicações', 'Token de referência, username do patrocinador', 'Quando participar do programa'],
            ['Pedidos', 'Itens, quantidades, valores, forma de pagamento, observações, troco', 'Sim (ao fazer pedido)'],
            ['Financeiro', 'Dados de pagamento PIX (processados pelo Mercado Pago, não armazenados pela FWC)', 'Quando pagar via PIX'],
          ].map(([c, d, o], i) => (
            <tr key={c} style={i % 2 === 1 ? s.trEven : {}}>
              <td style={{ ...s.td, fontWeight: 600 }}>{c}</td>
              <td style={s.td}>{d}</td>
              <td style={s.td}>{o}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={s.h3}>2.2. Parceiros (lojas / admins)</h3>
      <ul style={s.ul}>
        <li style={s.li}>Nome da empresa, CNPJ/CPF, e-mail, telefone, endereço completo.</li>
        <li style={s.li}>Dados de acesso: e-mail/senha (senha armazenada com hash bcrypt via Supabase Auth).</li>
        <li style={s.li}>Configurações da loja: logotipo, banner, horários, área de entrega, taxas, formas de pagamento, chave PIX.</li>
        <li style={s.li}>Dados operacionais: produtos, preços, estoque, vendas, caixa, clientes cadastrados.</li>
        <li style={s.li}>Dados WhatsApp: número de telefone, instância conectada, configurações de notificação, instruções do assistente de IA.</li>
        <li style={s.li}>Dados financeiros SaaS: plano contratado, valor de mensalidade, histórico de pagamentos, saldo de créditos WhatsApp.</li>
      </ul>

      <h3 style={s.h3}>2.3. Clientes B2B cadastrados pelos Parceiros (CRM interno)</h3>
      <ul style={s.ul}>
        <li style={s.li}>Nome, tipo (mercadinho, bar, restaurante etc.), telefone, e-mail, endereço, CNPJ/CPF.</li>
        <li style={s.li}>Dados comerciais: condição de pagamento, limite de crédito, desconto, histórico de compras, saldo em fiado, cascos em posse.</li>
        <li style={s.li}>Dados de relacionamento: dia de visita, observações, histórico de interações.</li>
      </ul>

      <h3 style={s.h3}>2.4. Dados técnicos coletados automaticamente</h3>
      <ul style={s.ul}>
        <li style={s.li}>Endereço IP (coletado pelo Supabase em operações de banco de dados).</li>
        <li style={s.li}>User-Agent (navegador/dispositivo).</li>
        <li style={s.li}>Timestamps de todas as ações (criação, atualização, acesso).</li>
        <li style={s.li}>Tokens de sessão JWT armazenados no localStorage do navegador.</li>
        <li style={s.li}>Carrinho de compras temporário armazenado no banco de dados (para bot WhatsApp).</li>
        <li style={s.li}>Coordenadas geográficas aproximadas (derivadas do endereço informado, para cálculo de entrega).</li>
      </ul>

      {/* ─── 3. FINALIDADES ─── */}
      <h2 style={s.h2}>3. Para Que Usamos os Dados</h2>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Finalidade</th>
            <th style={s.th}>Dados Utilizados</th>
            <th style={s.th}>Base Legal (LGPD)</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Autenticação e controle de acesso', 'E-mail, senha (hash), apelido, sessão JWT', 'Execução de contrato (art. 7º, V)'],
            ['Processamento de pedidos delivery', 'Nome, telefone, endereço, itens, valores', 'Execução de contrato (art. 7º, V)'],
            ['Cálculo de taxa e raio de entrega', 'CEP, endereço, coordenadas (via Nominatim)', 'Execução de contrato (art. 7º, V)'],
            ['Comunicação via WhatsApp (bot e notificações)', 'Número de telefone, conteúdo de mensagens, carrinho', 'Execução de contrato / Consentimento (art. 7º, I e V)'],
            ['Processamento de pagamento PIX', 'Nome, e-mail, valor do pedido (enviados ao Mercado Pago)', 'Execução de contrato (art. 7º, V)'],
            ['Gestão de estoque e vendas pelo Parceiro', 'Dados do cliente B2B, produtos, valores', 'Execução de contrato (art. 7º, V)'],
            ['Sistema de indicações / MLM', 'Username, token de referência, dados de referenciados', 'Consentimento (art. 7º, I)'],
            ['Notificações de estoque baixo', 'Número do Admin, produtos abaixo do mínimo', 'Legítimo interesse (art. 7º, IX)'],
            ['Auditoria e cumprimento de obrigações legais', 'Todos os dados transacionais e fiscais', 'Obrigação legal (art. 7º, II)'],
            ['Análise e melhoria da Plataforma', 'Dados agregados e anonimizados de uso', 'Legítimo interesse (art. 7º, IX)'],
            ['Prevenção a fraudes e segurança', 'IP, User-Agent, padrões de comportamento', 'Legítimo interesse (art. 7º, IX)'],
          ].map(([f, d, b], i) => (
            <tr key={f} style={i % 2 === 1 ? s.trEven : {}}>
              <td style={{ ...s.td, fontWeight: 600 }}>{f}</td>
              <td style={s.td}>{d}</td>
              <td style={s.td}>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ─── 4. COMPARTILHAMENTO ─── */}
      <h2 style={s.h2}>4. Com Quem Compartilhamos os Dados</h2>
      <p style={s.p}>
        A FWC não vende dados pessoais a terceiros. O compartilhamento ocorre apenas com parceiros tecnológicos
        necessários para a operação da Plataforma:
      </p>

      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Parceiro</th>
            <th style={s.th}>Finalidade</th>
            <th style={s.th}>Dados Compartilhados</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Supabase (EUA)', 'Banco de dados, autenticação, armazenamento de arquivos e funções de backend', 'Todos os dados da Plataforma (armazenados nos servidores sa-east-1 / Brasil)'],
            ['Mercado Pago (Brasil)', 'Processamento de pagamentos PIX', 'Nome, e-mail, valor do pedido, empresa emissora'],
            ['Evolution API (WhatsApp)', 'Envio e recebimento de mensagens WhatsApp para bot e notificações', 'Número de telefone, conteúdo das mensagens'],
            ['Anthropic / Claude AI (EUA)', 'Inteligência artificial do bot WhatsApp para interpretação de pedidos e respostas', 'Conteúdo das mensagens do usuário, dados do carrinho, produtos da loja'],
            ['Google (OAuth 2.0)', 'Autenticação via conta Google', 'E-mail, nome e foto de perfil (recebidos do Google com consentimento do usuário)'],
            ['ViaCEP (Brasil)', 'Preenchimento automático de endereço por CEP', 'CEP informado pelo usuário'],
            ['IBGE (Brasil)', 'Listagem de municípios por estado', 'Sigla do estado (sem dados pessoais)'],
            ['OpenStreetMap / Nominatim (Alemanha)', 'Geocodificação de endereços para cálculo de distância de entrega', 'Endereço formatado do cliente e da loja'],
          ].map(([p, f, d], i) => (
            <tr key={p} style={i % 2 === 1 ? s.trEven : {}}>
              <td style={{ ...s.td, fontWeight: 600 }}>{p}</td>
              <td style={s.td}>{f}</td>
              <td style={s.td}>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={s.warnBox}>
        <strong>⚠️ Transferência Internacional:</strong> Supabase, Anthropic e OpenStreetMap/Nominatim são serviços
        sediados fora do Brasil. A FWC adota as salvaguardas exigidas pela LGPD (art. 33) para essas transferências,
        incluindo cláusulas contratuais padrão e utilização de serviços com certificações de segurança reconhecidas.
      </div>

      <p style={s.p}>
        <strong>Autoridades Públicas:</strong> A FWC pode compartilhar dados com órgãos governamentais, autoridades
        fiscais, judiciais ou policiais quando obrigada por lei, decisão judicial ou autoridade competente.
      </p>

      {/* ─── 5. RETENÇÃO ─── */}
      <h2 style={s.h2}>5. Por Quanto Tempo Guardamos os Dados</h2>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Tipo de Dado</th>
            <th style={s.th}>Prazo de Retenção</th>
            <th style={s.th}>Justificativa</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Dados de conta (perfil, e-mail, senha)', 'Enquanto a conta estiver ativa + 2 anos após encerramento', 'Execução do contrato / Legítimo interesse'],
            ['Histórico de pedidos e transações', '5 anos após a transação', 'Obrigação legal (Código Tributário Nacional)'],
            ['Dados de caixa e movimentos financeiros', '5 anos', 'Obrigação legal fiscal'],
            ['Dados de estoque e vendas B2B', '5 anos', 'Obrigação legal fiscal'],
            ['Carrinho WhatsApp (temporário)', 'Até 30 dias sem atualização', 'Necessário para retomada de sessão'],
            ['Logs de acesso e IP', '6 meses', 'Marco Civil da Internet (Lei nº 12.965/2014, art. 15)'],
            ['Fotos e arquivos no Storage', 'Enquanto a conta do Parceiro estiver ativa', 'Execução do contrato'],
            ['Dados de pagamento PIX (Mercado Pago)', 'Conforme política do Mercado Pago', 'Operador de pagamentos'],
          ].map(([t, p, j], i) => (
            <tr key={t} style={i % 2 === 1 ? s.trEven : {}}>
              <td style={{ ...s.td, fontWeight: 600 }}>{t}</td>
              <td style={s.td}>{p}</td>
              <td style={s.td}>{j}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ─── 6. DIREITOS ─── */}
      <h2 style={s.h2}>6. Seus Direitos como Titular dos Dados</h2>
      <p style={s.p}>
        Nos termos da LGPD (art. 18), você tem os seguintes direitos sobre seus dados pessoais:
      </p>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Direito</th>
            <th style={s.th}>O que significa</th>
            <th style={s.th}>Como exercer</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Confirmação e Acesso', 'Saber se tratamos seus dados e obter cópia deles.', 'E-mail para franciscowildecjunior96@gmail.com'],
            ['Correção', 'Solicitar correção de dados incompletos, inexatos ou desatualizados.', 'Portal do perfil ou e-mail'],
            ['Anonimização / Bloqueio', 'Solicitar bloqueio ou anonimização de dados desnecessários.', 'E-mail para o DPO'],
            ['Eliminação', 'Solicitar exclusão de dados tratados com base no consentimento.', 'E-mail para o DPO (sujeito a prazo legal mínimo)'],
            ['Portabilidade', 'Receber seus dados em formato estruturado e legível.', 'E-mail para o DPO'],
            ['Revogação do consentimento', 'Retirar consentimento para tratamentos baseados nele.', 'E-mail para o DPO ou configurações da conta'],
            ['Informação sobre compartilhamento', 'Saber com quais entidades compartilhamos seus dados.', 'Esta Política (seção 4)'],
            ['Oposição', 'Opor-se a tratamentos realizados por legítimo interesse.', 'E-mail para o DPO'],
          ].map(([d, o, c], i) => (
            <tr key={d} style={i % 2 === 1 ? s.trEven : {}}>
              <td style={{ ...s.td, fontWeight: 600 }}>{d}</td>
              <td style={s.td}>{o}</td>
              <td style={s.td}>{c}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={s.infoBox}>
        <strong>⏱ Prazo de resposta:</strong> Atendemos solicitações de direitos em até <strong>15 dias úteis</strong> a
        partir do recebimento. Alguns direitos podem ser limitados por obrigações legais (ex.: dados fiscais não podem
        ser excluídos antes do prazo legal de 5 anos).
      </div>

      {/* ─── 7. SEGURANÇA ─── */}
      <h2 style={s.h2}>7. Como Protegemos os Dados</h2>
      <p style={s.p}>A FWC adota medidas técnicas e organizacionais para proteger os dados pessoais, incluindo:</p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Criptografia em trânsito:</strong> todas as comunicações utilizam HTTPS/TLS.</li>
        <li style={s.li}><strong>Criptografia em repouso:</strong> senhas armazenadas com hash bcrypt via Supabase Auth; dados em banco criptografados pelo Supabase.</li>
        <li style={s.li}><strong>Controle de acesso:</strong> Row Level Security (RLS) no banco de dados garante que cada empresa/usuário acesse apenas seus próprios dados.</li>
        <li style={s.li}><strong>Autenticação:</strong> tokens JWT com expiração automática; suporte a OAuth 2.0 (Google).</li>
        <li style={s.li}><strong>Isolamento multi-tenant:</strong> dados de cada empresa são isolados por <em>empresa_id</em> em todas as tabelas.</li>
        <li style={s.li}><strong>API Keys em variáveis de ambiente:</strong> chaves de serviços externos (Anthropic, Mercado Pago, Evolution API) nunca são expostas no frontend.</li>
        <li style={s.li}><strong>Edge Functions:</strong> operações sensíveis executadas em ambiente servidor isolado (Supabase Edge Functions / Deno).</li>
      </ul>
      <p style={s.p}>
        Apesar de todos os esforços, nenhum sistema é 100% invulnerável. Em caso de incidente de segurança que afete
        dados pessoais, a FWC notificará os titulares e a ANPD (Autoridade Nacional de Proteção de Dados) nos prazos
        previstos na LGPD.
      </p>

      {/* ─── 8. COOKIES / LOCALSTORAGE ─── */}
      <h2 style={s.h2}>8. Cookies e Armazenamento Local</h2>
      <p style={s.p}>A Plataforma utiliza <strong>localStorage</strong> do navegador para armazenar:</p>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Item</th>
            <th style={s.th}>Conteúdo</th>
            <th style={s.th}>Finalidade</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Token de sessão JWT', 'Token de autenticação Supabase', 'Manter o usuário autenticado entre navegações'],
            ['Preferência de tema', 'Claro / Escuro', 'Personalização visual'],
            ['Carrinho de compras (delivery)', 'Itens selecionados, quantidade, preços', 'Preservar carrinho durante navegação'],
            ['Backup de sessão (super admin)', 'Token temporário durante impersonação', 'Retorno à conta original após impersonação'],
          ].map(([item, cont, fin], i) => (
            <tr key={item} style={i % 2 === 1 ? s.trEven : {}}>
              <td style={{ ...s.td, fontWeight: 600 }}>{item}</td>
              <td style={s.td}>{cont}</td>
              <td style={s.td}>{fin}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={s.p}>
        A Plataforma não utiliza cookies de rastreamento publicitário ou de terceiros para fins de marketing.
        O usuário pode limpar o localStorage a qualquer momento pelo próprio navegador, o que encerrará a sessão ativa.
      </p>

      {/* ─── 9. BOT WHATSAPP ─── */}
      <h2 style={s.h2}>9. Bot WhatsApp e Inteligência Artificial</h2>
      <p style={s.p}>
        <strong>9.1.</strong> Ao interagir com o bot WhatsApp da Plataforma, suas mensagens são processadas pela
        <strong> Anthropic (Claude AI)</strong> para interpretação de intenções e geração de respostas. As mensagens
        são enviadas para a API da Anthropic com o mínimo de dados necessário (conteúdo da mensagem, contexto do
        carrinho e catálogo da loja).
      </p>
      <p style={s.p}>
        <strong>9.2.</strong> O número de telefone do usuário é processado pela <strong>Evolution API</strong> para
        envio e recebimento de mensagens via WhatsApp Business.
      </p>
      <p style={s.p}>
        <strong>9.3.</strong> O histórico de conversa e carrinho são armazenados temporariamente no banco de dados
        para permitir retomada de sessões. Esses dados são eliminados automaticamente após 30 dias sem interação.
      </p>
      <p style={s.p}>
        <strong>9.4.</strong> O usuário pode encerrar a interação com o bot a qualquer momento enviando a mensagem
        <em> "cancelar"</em> ou <em>"parar"</em>. Para exclusão do histórico de conversa, entre em contato com
        franciscowildecjunior96@gmail.com.
      </p>

      {/* ─── 10. MENORES ─── */}
      <h2 style={s.h2}>10. Menores de Idade</h2>
      <p style={s.p}>
        <strong>10.1.</strong> A Plataforma FWC Inter não é destinada a menores de 18 (dezoito) anos. Não coletamos
        intencionalmente dados de menores. Caso identifiquemos o cadastro de um menor, a conta será imediatamente
        encerrada e os dados excluídos.
      </p>
      <p style={s.p}>
        <strong>10.2.</strong> Pedidos de bebidas alcoólicas são restritos a maiores de 18 anos. Ao realizar tal
        pedido, o usuário declara ter idade legal, sendo sua responsabilidade a veracidade desta declaração.
      </p>

      {/* ─── 11. LGPD ─── */}
      <h2 style={s.h2}>11. Bases Legais e Consentimento</h2>
      <p style={s.p}>
        Todo o tratamento de dados pela FWC possui base legal definida na LGPD. As principais bases utilizadas são:
      </p>
      <ul style={s.ul}>
        <li style={s.li}><span style={s.tag}>Art. 7º, I</span> <strong>Consentimento:</strong> utilizado para o Sistema de Indicações e comunicações de marketing opcionais.</li>
        <li style={s.li}><span style={s.tag}>Art. 7º, II</span> <strong>Obrigação Legal:</strong> retenção de dados fiscais e tributários pelo prazo mínimo exigido em lei.</li>
        <li style={s.li}><span style={s.tag}>Art. 7º, V</span> <strong>Execução de Contrato:</strong> processamento de pedidos, autenticação, pagamentos e entrega de funcionalidades contratadas.</li>
        <li style={s.li}><span style={s.tag}>Art. 7º, IX</span> <strong>Legítimo Interesse:</strong> segurança da Plataforma, prevenção a fraudes, análise de melhorias e notificações operacionais.</li>
      </ul>

      {/* ─── 12. ATUALIZAÇÕES ─── */}
      <h2 style={s.h2}>12. Atualizações desta Política</h2>
      <p style={s.p}>
        Esta Política pode ser atualizada periodicamente para refletir mudanças na Plataforma, na legislação ou nas
        práticas de privacidade. Alterações relevantes serão comunicadas por e-mail cadastrado ou notificação na
        Plataforma com antecedência mínima de 10 (dez) dias.
      </p>
      <p style={s.p}>
        A versão vigente sempre estará disponível em <strong>/privacidade</strong> na Plataforma. A data da última
        atualização está indicada no topo deste documento.
      </p>

      {/* ─── 13. CONTATO DPO ─── */}
      <h2 style={s.h2}>13. Encarregado de Dados (DPO) e Contato</h2>
      <p style={s.p}>
        Para exercer seus direitos, tirar dúvidas ou fazer reclamações sobre o tratamento de seus dados pessoais,
        entre em contato com nosso Encarregado de Dados:
      </p>
      <div style={s.box}>
        <strong>Francisco Wilde Cunha Junior</strong> — Encarregado de Dados (DPO)<br />
        E-mail: <strong>franciscowildecjunior96@gmail.com</strong><br />
        Telefone: (84) 9818-0774<br />
        Prazo de resposta: até 15 dias úteis
      </div>
      <p style={s.p}>
        Você também pode apresentar reclamações à <strong>Autoridade Nacional de Proteção de Dados (ANPD)</strong>
        pelo site <em>gov.br/anpd</em>, caso considere que seus direitos não foram atendidos adequadamente.
      </p>

      {/* ─── FOOTER ─── */}
      <div style={s.footer}>
        <strong>FWC INTERMEDIAÇÕES LTDA</strong><br />
        CNPJ 66.437.917/0001-66<br />
        Av. Nascimento de Castro, 81 — Dix-Sept Rosado — Natal/RN — CEP 59.054-180<br />
        E-mail: franciscowildecjunior96@gmail.com | Tel: (84) 9818-0774<br /><br />
        <Link to="/termos" style={{ color: '#6c2bd9' }}>Ver Termos de Uso →</Link>
      </div>
    </div>
  )
}
