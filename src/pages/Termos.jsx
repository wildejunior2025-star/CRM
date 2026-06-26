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
}

export default function Termos() {
  useEffect(() => {
    window.scrollTo(0, 0)
    document.title = 'Termos de Uso — FWC Inter'
  }, [])

  return (
    <div style={s.page}>
      <div style={s.logo}>
        <span style={s.logoText}>FWC Inter</span>
      </div>

      <Link to="/" style={s.backLink}>← Voltar</Link>

      <h1 style={s.h1}>Termos de Uso</h1>
      <p style={s.updated}>Última atualização: 21 de junho de 2026</p>

      <div style={s.intro}>
        Leia este documento com atenção antes de utilizar a Plataforma FWC Inter. Ao acessar, cadastrar-se ou utilizar
        qualquer funcionalidade, você declara ter lido, compreendido e concordado integralmente com estes Termos de Uso.
        Caso não concorde com qualquer disposição aqui prevista, não utilize a Plataforma.
      </div>

      {/* ─── 1. PARTES E DEFINIÇÕES ─── */}
      <h2 style={s.h2}>1. Das Partes e Definições</h2>
      <p style={s.p}>
        <strong>1.1.</strong> A plataforma <strong>FWC Inter</strong> é desenvolvida e operada por:
      </p>
      <div style={s.box}>
        <strong>FWC INTERMEDIAÇÕES LTDA</strong><br />
        CNPJ: 66.437.917/0001-66<br />
        Av. Nascimento de Castro, nº 81, Dix-Sept Rosado, Natal – RN, CEP: 59.054-180<br />
        E-mail: franciscowildecjunior96@gmail.com | Telefone: (84) 9818-0774
      </div>
      <p style={s.p}>
        <strong>1.2.</strong> Para os fins destes Termos, os seguintes termos têm os significados abaixo:
      </p>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Termo</th>
            <th style={s.th}>Definição</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['FWC / Empresa / Nós', 'FWC INTERMEDIAÇÕES LTDA, desenvolvedora e operadora da Plataforma FWC Inter.'],
            ['Plataforma', 'Sistema FWC Inter, composto por painel web (CRM), portal do cliente, aplicativo móvel e bot WhatsApp.'],
            ['Parceiro / Loja', 'Pessoa jurídica ou física que contrata o plano SaaS da FWC para gerir seu negócio na Plataforma.'],
            ['Usuário Interno', 'Administrador ou vendedor cadastrado pelo Parceiro para operar o sistema.'],
            ['Cliente Final', 'Consumidor que acessa o portal de delivery ou realiza pedidos via WhatsApp bot.'],
            ['Pedido', 'Solicitação de compra realizada por Cliente Final ao Parceiro por meio da Plataforma.'],
            ['Créditos WhatsApp', 'Unidades de consumo deduzidas a cada mensagem enviada pelo bot da Plataforma.'],
            ['Sistema de Indicações', 'Programa de referência onde Clientes Finais ganham benefícios ao indicar novos cadastros.'],
          ].map(([t, d], i) => (
            <tr key={t} style={i % 2 === 1 ? s.trEven : {}}>
              <td style={{ ...s.td, fontWeight: 600, whiteSpace: 'nowrap' }}>{t}</td>
              <td style={s.td}>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ─── 2. OBJETO ─── */}
      <h2 style={s.h2}>2. Do Objeto</h2>
      <p style={s.p}>
        <strong>2.1.</strong> A Plataforma FWC Inter oferece:
      </p>
      <ul style={s.ul}>
        <li style={s.li}><strong>Para Parceiros (B2B):</strong> sistema SaaS de gestão comercial, incluindo controle de clientes, estoque, vendas, caixa, financeiro, painel de pedidos delivery, bot WhatsApp inteligente e portal white-label para seus clientes finais.</li>
        <li style={s.li}><strong>Para Clientes Finais (B2C):</strong> portal de marketplace para visualização de lojas, catálogo de produtos, realização de pedidos delivery e acompanhamento em tempo real.</li>
        <li style={s.li}><strong>Para ambos:</strong> comunicação automatizada via WhatsApp e sistema de indicações com benefícios.</li>
      </ul>
      <p style={s.p}>
        <strong>2.2.</strong> A FWC atua exclusivamente como intermediadora tecnológica. O contrato de compra e venda de produtos é celebrado diretamente entre o Parceiro e o Cliente Final, sendo a FWC alheia às obrigações decorrentes desse negócio.
      </p>

      {/* ─── 3. CADASTRO E ACESSO ─── */}
      <h2 style={s.h2}>3. Do Cadastro e Acesso</h2>
      <p style={s.p}>
        <strong>3.1.</strong> O acesso à Plataforma exige cadastro prévio. O usuário é o único responsável pela veracidade, exatidão e atualização das informações fornecidas, respondendo civil e criminalmente por informações falsas.
      </p>
      <p style={s.p}>
        <strong>3.2.</strong> Credenciais de acesso (e-mail/senha ou apelido/senha) são pessoais e intransferíveis. O Parceiro deve manter suas credenciais em sigilo e notificar imediatamente a FWC em caso de uso não autorizado.
      </p>
      <p style={s.p}>
        <strong>3.3.</strong> O cadastro de Parceiro pode ser realizado pelo próprio responsável legal ou por terceiro expressamente autorizado. O Parceiro declara possuir capacidade jurídica plena para contratar.
      </p>
      <p style={s.p}>
        <strong>3.4.</strong> A FWC reserva-se o direito de recusar, suspender ou cancelar cadastros que violem estes Termos, sem aviso prévio e sem obrigação de indenização.
      </p>
      <p style={s.p}>
        <strong>3.5.</strong> O login pode ser realizado por e-mail/senha, apelido/senha ou conta Google (OAuth 2.0). O usuário consente com o compartilhamento dos dados básicos do Google (nome, e-mail, foto) para fins de autenticação.
      </p>

      {/* ─── 4. PERFIS DE USUÁRIO ─── */}
      <h2 style={s.h2}>4. Dos Perfis de Usuário e Permissões</h2>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Perfil</th>
            <th style={s.th}>Acesso</th>
            <th style={s.th}>Responsabilidade</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Super Admin', 'Acesso total à Plataforma, gestão de Parceiros e configurações globais.', 'FWC INTERMEDIAÇÕES LTDA.'],
            ['Admin (Parceiro)', 'Gestão completa da empresa: clientes, produtos, estoque, vendas, caixa, pedidos, WhatsApp.', 'O Parceiro contratante.'],
            ['Vendedor', 'Vendas, caixa, visualização de clientes e relatórios.', 'O Parceiro que o cadastrou.'],
            ['Cliente Final', 'Portal de lojas, catálogo, pedidos, perfil e saldo fiado.', 'O próprio usuário.'],
          ].map(([p, a, r], i) => (
            <tr key={p} style={i % 2 === 1 ? s.trEven : {}}>
              <td style={{ ...s.td, fontWeight: 600 }}>{p}</td>
              <td style={s.td}>{a}</td>
              <td style={s.td}>{r}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ─── 5. OBRIGAÇÕES DO PARCEIRO ─── */}
      <h2 style={s.h2}>5. Das Obrigações e Responsabilidades do Parceiro</h2>
      <p style={s.p}><strong>5.1.</strong> O Parceiro é o único responsável por:</p>
      <ul style={s.ul}>
        <li style={s.li}>A exatidão das informações cadastradas (produtos, preços, horários, área de entrega, taxas).</li>
        <li style={s.li}>A qualidade, preparo, embalagem e entrega dos produtos aos Clientes Finais.</li>
        <li style={s.li}>O cumprimento de todas as obrigações fiscais, sanitárias, trabalhistas e previdenciárias referentes à sua operação.</li>
        <li style={s.li}>A emissão de nota fiscal ou documento equivalente para cada venda realizada.</li>
        <li style={s.li}>A verificação da maioridade do cliente em pedidos de bebidas alcoólicas ou produtos com restrição etária.</li>
        <li style={s.li}>O cadastro, treinamento e conduta dos Usuários Internos (vendedores) vinculados à sua conta.</li>
        <li style={s.li}>A manutenção do estoque atualizado, evitando pedidos de itens indisponíveis.</li>
      </ul>
      <p style={s.p}>
        <strong>5.2.</strong> O Parceiro não poderá disponibilizar canais de contato direto (telefone, redes sociais, apps concorrentes) ao Cliente Final por meio das funcionalidades da Plataforma, exceto os dados já presentes no seu cadastro público.
      </p>
      <p style={s.p}>
        <strong>5.3.</strong> O Parceiro compromete-se a manter a FWC livre e indene de quaisquer perdas, danos, penalidades ou demandas decorrentes de sua operação, seus produtos, atos de seus funcionários ou de descumprimento destes Termos.
      </p>

      {/* ─── 6. PEDIDOS DELIVERY ─── */}
      <h2 style={s.h2}>6. Dos Pedidos Delivery</h2>
      <p style={s.p}>
        <strong>6.1.</strong> O fluxo de pedidos delivery segue os status: <em>aguardando → confirmado → em preparo → saiu para entrega → entregue</em>, podendo ser cancelado em qualquer etapa anterior à entrega.
      </p>
      <p style={s.p}>
        <strong>6.2.</strong> O Parceiro deve aceitar, recusar ou cancelar pedidos por meio do Painel de Pedidos da Plataforma. Cancelamentos excessivos e injustificados podem resultar em suspensão do recurso de delivery.
      </p>
      <p style={s.p}>
        <strong>6.3.</strong> O Cliente Final pode cancelar o pedido enquanto ele estiver no status <em>aguardando</em>. Após confirmação pelo Parceiro, o cancelamento fica sujeito à política do próprio Parceiro.
      </p>
      <p style={s.p}>
        <strong>6.4.</strong> A taxa de entrega é definida pelo Parceiro com base em faixas de distância configuradas por ele. A FWC não define, cobra nem retém valores de taxa de entrega — esses valores pertencem integralmente ao Parceiro.
      </p>
      <p style={s.p}>
        <strong>6.5.</strong> A verificação do raio de entrega é feita automaticamente pela Plataforma com base na localização informada pelo Cliente Final. Endereços fora do raio configurado pelo Parceiro não poderão concluir o pedido.
      </p>
      <p style={s.p}>
        <strong>6.6.</strong> A FWC não é responsável por atrasos, produtos danificados, entregas ao endereço errado ou qualquer problema na execução do pedido, sendo tal responsabilidade exclusiva do Parceiro.
      </p>

      {/* ─── 7. PAGAMENTOS ─── */}
      <h2 style={s.h2}>7. Dos Pagamentos</h2>
      <h3 style={s.h3}>7.1. Pagamento via PIX</h3>
      <p style={s.p}>
        O pagamento por PIX é processado por integração com o <strong>Mercado Pago</strong>. Ao selecionar essa forma, o Cliente Final recebe um QR Code com validade de 30 minutos. O pedido é confirmado automaticamente após a aprovação do pagamento pelo Mercado Pago. A FWC não armazena dados de cartão ou credenciais bancárias — toda transação financeira é processada exclusivamente pelo gateway de pagamento.
      </p>
      <h3 style={s.h3}>7.2. Pagamento em Dinheiro</h3>
      <p style={s.p}>
        O pagamento em dinheiro ocorre presencialmente no ato da entrega, entre o Cliente Final e o entregador do Parceiro. A FWC não intervém nessa transação.
      </p>
      <h3 style={s.h3}>7.3. Reembolsos e Estornos</h3>
      <p style={s.p}>
        Em caso de cancelamento de pedido pago via PIX antes da entrega, o reembolso seguirá as regras do Mercado Pago e a política do Parceiro. A FWC não efetua estornos diretamente — o Cliente Final deve acionar o Parceiro e, se necessário, o Mercado Pago.
      </p>
      <h3 style={s.h3}>7.4. Mensalidade SaaS</h3>
      <p style={s.p}>
        O Parceiro paga mensalidade à FWC pelo uso da Plataforma, conforme plano contratado. O não pagamento nos prazos acordados pode resultar em suspensão do acesso, conforme cláusula 14.
      </p>

      {/* ─── 8. CRÉDITOS WHATSAPP ─── */}
      <h2 style={s.h2}>8. Do Sistema de Créditos WhatsApp</h2>
      <p style={s.p}>
        <strong>8.1.</strong> O envio de mensagens pelo bot WhatsApp consome Créditos WhatsApp, à razão de 1 (um) crédito por mensagem enviada pela Plataforma.
      </p>
      <p style={s.p}>
        <strong>8.2.</strong> O saldo de créditos é gerenciado pelo Super Admin e pode ser recarregado mediante solicitação. Sem saldo suficiente, o envio de mensagens automáticas é interrompido.
      </p>
      <p style={s.p}>
        <strong>8.3.</strong> Créditos não são transferíveis entre Parceiros e não têm valor monetário resgatável, salvo acordo escrito com a FWC.
      </p>
      <p style={s.p}>
        <strong>8.4.</strong> A FWC não garante a entrega de mensagens WhatsApp, pois depende da disponibilidade da Evolution API e da operadora de telefonia. Falhas técnicas nesses terceiros não geram direito a restituição de créditos.
      </p>

      {/* ─── 9. SISTEMA DE INDICAÇÕES ─── */}
      <h2 style={s.h2}>9. Do Programa de Indicações (Pontos)</h2>
      <p style={s.p}>
        <strong>9.1.</strong> O Sistema de Indicações permite que Clientes Finais indiquem novos usuários por meio de link/token único, podendo gerar <strong>pontos de fidelidade</strong> conforme regras definidas pelo Super Admin da Plataforma. Os pontos são um benefício de fidelidade e só podem ser utilizados como <strong>desconto em compras dentro do próprio app</strong>, não possuindo valor monetário, não sendo conversíveis em dinheiro e não permitindo saque, resgate em espécie ou transferência para terceiros.
      </p>
      <p style={s.p}>
        <strong>9.2.</strong> Os valores e percentuais de pontos podem ser alterados a qualquer momento pela FWC, mediante comunicação prévia de 10 (dez) dias.
      </p>
      <p style={s.p}>
        <strong>9.3.</strong> A participação no Sistema de Indicações é facultativa. O usuário que indica não cria vínculo empregatício, societário ou de representação comercial com a FWC.
      </p>
      <p style={s.p}>
        <strong>9.4.</strong> A FWC reserva-se o direito de suspender ou encerrar o Programa de Indicações a qualquer momento, sem obrigação de manutenção de pontos ou benefícios futuros.
      </p>

      {/* ─── 10. OBRIGAÇÕES DO CLIENTE FINAL ─── */}
      <h2 style={s.h2}>10. Das Obrigações do Cliente Final</h2>
      <ul style={s.ul}>
        <li style={s.li}>Fornecer informações verdadeiras e atualizadas no cadastro e no checkout.</li>
        <li style={s.li}>Informar endereço de entrega correto e completo.</li>
        <li style={s.li}>Estar presente ou disponível no endereço informado no momento da entrega.</li>
        <li style={s.li}>Não utilizar a Plataforma para pedidos fraudulentos ou com intenção de cancelamento abusivo.</li>
        <li style={s.li}>Ser maior de 18 (dezoito) anos para realizar pedidos de bebidas alcoólicas, responsabilizando-se pela declaração.</li>
        <li style={s.li}>Não compartilhar suas credenciais com terceiros.</li>
      </ul>

      {/* ─── 11. PROIBIÇÕES ─── */}
      <h2 style={s.h2}>11. Das Condutas Proibidas</h2>
      <p style={s.p}>É vedado a qualquer usuário da Plataforma:</p>
      <ul style={s.ul}>
        <li style={s.li}>Utilizar a Plataforma para atividades ilegais, fraudulentas ou que violem direitos de terceiros.</li>
        <li style={s.li}>Realizar engenharia reversa, decompilação ou tentativa de acesso não autorizado ao código-fonte, banco de dados ou infraestrutura da Plataforma.</li>
        <li style={s.li}>Inserir vírus, malware ou qualquer código malicioso na Plataforma.</li>
        <li style={s.li}>Tentar sobrecarregar, atacar (DoS/DDoS) ou comprometer a segurança da infraestrutura.</li>
        <li style={s.li}>Coletar dados de outros usuários sem autorização.</li>
        <li style={s.li}>Criar múltiplos cadastros para fins de burlar regras ou obter vantagens indevidas.</li>
        <li style={s.li}>Utilizar dados dos Clientes Finais obtidos pela Plataforma para fins alheios à execução dos pedidos.</li>
        <li style={s.li}>Reproduzir, distribuir ou explorar comercialmente a Plataforma ou partes dela sem autorização expressa da FWC.</li>
      </ul>

      {/* ─── 12. PROPRIEDADE INTELECTUAL ─── */}
      <h2 style={s.h2}>12. Da Propriedade Intelectual</h2>
      <p style={s.p}>
        <strong>12.1.</strong> Todos os direitos de propriedade intelectual sobre a Plataforma FWC Inter — incluindo código-fonte, design, marcas, logotipos, textos e funcionalidades — pertencem exclusivamente à FWC INTERMEDIAÇÕES LTDA.
      </p>
      <p style={s.p}>
        <strong>12.2.</strong> Nenhum direito de propriedade intelectual é transferido ao usuário pelo uso da Plataforma. O acesso concedido é uma licença limitada, não exclusiva, intransferível e revogável para uso pessoal ou empresarial conforme estes Termos.
      </p>
      <p style={s.p}>
        <strong>12.3.</strong> O Parceiro outorga à FWC licença gratuita de uso de sua marca, logotipo e conteúdo (fotos de produtos, banners) exclusivamente para exibição na Plataforma durante a vigência do contrato.
      </p>
      <p style={s.p}>
        <strong>12.4.</strong> O Parceiro declara ser titular ou ter autorização legal para uso de todo o conteúdo que inserir na Plataforma, respondendo por eventuais violações de direitos de terceiros.
      </p>

      {/* ─── 13. LIMITAÇÃO DE RESPONSABILIDADE ─── */}
      <h2 style={s.h2}>13. Da Limitação de Responsabilidade</h2>
      <p style={s.p}>
        <strong>13.1.</strong> A FWC não responde por danos diretos, indiretos, incidentais, emergentes, lucros cessantes ou perda de oportunidade decorrentes de:
      </p>
      <ul style={s.ul}>
        <li style={s.li}>Falhas, interrupções ou indisponibilidades da Plataforma não provocadas pela FWC (incluindo falhas de terceiros como Supabase, Mercado Pago, Evolution API, WhatsApp, operadoras de telefonia ou provedores de internet).</li>
        <li style={s.li}>Atos praticados pelo Parceiro ou por seus funcionários e entregadores.</li>
        <li style={s.li}>Qualidade, segurança ou adequação dos produtos vendidos pelos Parceiros.</li>
        <li style={s.li}>Erros em endereços informados pelo Cliente Final.</li>
        <li style={s.li}>Falhas de pagamento ou chargebacks processados pelo Mercado Pago.</li>
        <li style={s.li}>Mensagens não entregues pelo bot WhatsApp por falha na Evolution API ou operadora.</li>
        <li style={s.li}>Uso indevido de credenciais por terceiros não autorizado.</li>
      </ul>
      <p style={s.p}>
        <strong>13.2.</strong> A responsabilidade máxima da FWC, em qualquer hipótese, fica limitada ao valor pago pelo Parceiro à FWC nos últimos 3 (três) meses de contrato.
      </p>
      <p style={s.p}>
        <strong>13.3.</strong> A FWC fornece a Plataforma no estado em que se encontra ("as is"), sem garantia de disponibilidade ininterrupta. A FWC compromete-se a empregar esforços razoáveis para manter a Plataforma disponível, mas não garante operação 24/7 sem falhas.
      </p>

      {/* ─── 14. SUSPENSÃO E CANCELAMENTO ─── */}
      <h2 style={s.h2}>14. Da Suspensão, Cancelamento e Rescisão</h2>
      <p style={s.p}>
        <strong>14.1.</strong> A FWC poderá suspender ou encerrar o acesso de qualquer usuário, sem aviso prévio, nos seguintes casos:
      </p>
      <ul style={s.ul}>
        <li style={s.li}>Violação destes Termos de Uso.</li>
        <li style={s.li}>Atraso no pagamento da mensalidade SaaS superior a 10 (dez) dias.</li>
        <li style={s.li}>Fornecimento de informações falsas no cadastro.</li>
        <li style={s.li}>Uso da Plataforma para fins ilegais ou prejudiciais a terceiros.</li>
        <li style={s.li}>Determinação judicial ou de autoridade competente.</li>
      </ul>
      <p style={s.p}>
        <strong>14.2.</strong> O Parceiro pode cancelar sua conta a qualquer momento mediante solicitação escrita à FWC. O cancelamento não gera direito a reembolso de mensalidades já pagas ou de créditos WhatsApp não utilizados, salvo acordo expresso entre as partes.
      </p>
      <p style={s.p}>
        <strong>14.3.</strong> O Cliente Final pode excluir sua conta a qualquer momento pelo portal. A exclusão implica perda de histórico, saldo de pontos de fidelidade e dados de pedidos associados ao perfil.
      </p>
      <p style={s.p}>
        <strong>14.4.</strong> Após o cancelamento ou rescisão, os dados do Parceiro poderão ser mantidos pela FWC pelo prazo legal mínimo para fins de auditoria fiscal (5 anos), conforme obrigação legal.
      </p>

      {/* ─── 15. PRIVACIDADE ─── */}
      <h2 style={s.h2}>15. Da Privacidade e Proteção de Dados</h2>
      <p style={s.p}>
        <strong>15.1.</strong> O tratamento de dados pessoais realizado pela FWC é regido pela <strong>Lei Geral de Proteção de Dados (Lei nº 13.709/2018 – LGPD)</strong> e detalhado na nossa{' '}
        <Link to="/privacidade" style={{ color: '#6c2bd9' }}>Política de Privacidade</Link>, parte integrante destes Termos.
      </p>
      <p style={s.p}>
        <strong>15.2.</strong> O Parceiro, ao coletar dados de seus Clientes Finais por meio da Plataforma, atua como <em>operador</em> dos dados, devendo observar a LGPD e garantir base legal adequada para o tratamento.
      </p>

      {/* ─── 16. ALTERAÇÕES ─── */}
      <h2 style={s.h2}>16. Das Alterações nos Termos</h2>
      <p style={s.p}>
        <strong>16.1.</strong> A FWC pode alterar estes Termos a qualquer momento. Alterações serão comunicadas com antecedência mínima de 10 (dez) dias por e-mail cadastrado ou notificação na Plataforma.
      </p>
      <p style={s.p}>
        <strong>16.2.</strong> A continuidade do uso da Plataforma após a vigência da nova versão implica aceitação automática das alterações. Se o usuário não concordar, deverá cancelar sua conta antes da data de entrada em vigor.
      </p>
      <p style={s.p}>
        <strong>16.3.</strong> Para adequações a exigências legais ou regulatórias, prazos menores de notificação podem ser aplicados.
      </p>

      {/* ─── 17. INTEGRIDADE ─── */}
      <h2 style={s.h2}>17. Das Boas Práticas e Integridade</h2>
      <p style={s.p}>
        <strong>17.1.</strong> O Parceiro e seus representantes devem observar a legislação anticorrupção (Lei nº 12.846/2013), antissuborno, antilavagem de dinheiro e demais normas de conformidade aplicáveis.
      </p>
      <p style={s.p}>
        <strong>17.2.</strong> É terminantemente proibida qualquer forma de trabalho infantil nos estabelecimentos dos Parceiros vinculados à Plataforma, sob pena de rescisão imediata do contrato e notificação às autoridades competentes.
      </p>

      {/* ─── 18. DISPOSIÇÕES GERAIS ─── */}
      <h2 style={s.h2}>18. Disposições Gerais</h2>
      <p style={s.p}>
        <strong>18.1.</strong> A relação entre a FWC e o Parceiro é de prestação de serviços tecnológicos, não estabelecendo vínculo empregatício, societário, de representação comercial ou consumerista entre as partes.
      </p>
      <p style={s.p}>
        <strong>18.2.</strong> A invalidade de qualquer cláusula destes Termos não afeta a validade das demais.
      </p>
      <p style={s.p}>
        <strong>18.3.</strong> A tolerância de qualquer parte quanto ao descumprimento de obrigações não implica renúncia ou novação.
      </p>
      <p style={s.p}>
        <strong>18.4.</strong> Estes Termos são regidos pelas leis da República Federativa do Brasil.
      </p>

      {/* ─── 19. FORO ─── */}
      <h2 style={s.h2}>19. Do Foro</h2>
      <p style={s.p}>
        Fica eleito o foro da Comarca de <strong>Natal – RN</strong> para dirimir quaisquer controvérsias decorrentes destes Termos ou do uso da Plataforma, com renúncia expressa a qualquer outro, por mais privilegiado que seja.
      </p>

      {/* ─── FOOTER ─── */}
      <div style={s.footer}>
        <strong>FWC INTERMEDIAÇÕES LTDA</strong><br />
        CNPJ 66.437.917/0001-66<br />
        Av. Nascimento de Castro, 81 — Dix-Sept Rosado — Natal/RN — CEP 59.054-180<br />
        E-mail: franciscowildecjunior96@gmail.com | Tel: (84) 9818-0774<br /><br />
        Para dúvidas sobre estes Termos, entre em contato pelo e-mail acima.<br />
        <Link to="/privacidade" style={{ color: '#6c2bd9' }}>Ver Política de Privacidade →</Link>
      </div>
    </div>
  )
}
