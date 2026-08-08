# Migração do bot para o WhatsApp Cloud API oficial

> Última conferência: **07/08/2026**

## Onde estamos

A Meta **aprovou** o app em 06/08/2026 e o **número real já está cadastrado e conectado**.

### Número de produção ✅

| Dado | Valor |
|---|---|
| Número | **+55 84 99821-4212** (chip novo, comprado 07/08/2026) |
| Nome de exibição | **FWC Inter** |
| Categoria | Serviços profissionais |
| Status | 🟢 Conectado |
| **WABA** | `FWC Inter` — id `1703146970738801` |
| **Phone Number ID** | `1149971294875569` |
| PIN (2 etapas) | `101520` |

Gravado em `whatsapp_config` da **Estação do Sabor** (`39c20133-3272-4ee5-add3-7a54895d4f29`,
loja do próprio usuário) com `ia_ativo = true`, e em `config_global` nas chaves `admin_cloud_*`.

O Evolution dessa loja está morto — o número antigo `558498146380` foi excluído do WhatsApp,
então o `connected_phone` foi limpo. A loja roda **só na Cloud API**.

⚠️ `whatsapp_config` tem `UNIQUE (empresa_id)` — uma linha por loja. Não dá pra ter uma linha
"de teste" e outra "de produção" na mesma empresa; a CDBom usa um `instance_name` sintético
(`cloud_test_cdbom`) justamente por isso.

### Aprovado ✅

| Item | Valor |
|---|---|
| App | `Atendimento Elshaday` — id `2285733882190923` — modo **Ao vivo** |
| Portfólio | `1186584751211342` (conta da Gaby / Iris Gabryella Lima da Silva) |
| `whatsapp_business_messaging` | Approved (06/08/2026) |
| `whatsapp_business_management` | Approved (06/08/2026) |
| Provedor de Tecnologia | **Verificado — integração concluída** |
| Usuário do sistema | `botatende` — id `61592128873337` — acesso Admin, app com acesso total |

### Já construído ✅

| Peça | Estado |
|---|---|
| Edge function `whatsapp-cloud` | ACTIVE v11, `verify_jwt: false` |
| URL de callback no app | `https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/whatsapp-cloud` |
| Verify token | configurado |
| Campo `messages` do webhook | **Assinado** |
| Colunas no `whatsapp_config` | `cloud_phone_number_id`, `cloud_display_number`, `cloud_waba_id`, `cloud_pin`, `cloud_verified_name` |
| Número de teste ligado | loja **CDBom** → `cloud_phone_number_id = 1135024189705181` |
| `whatsapp-cloud-signup` | esqueleto para o Cadastro Incorporado (fase 2) |

Como funciona o `whatsapp-cloud`: recebe o webhook da Meta → acha a loja pelo
`cloud_phone_number_id` → chama o `whatsapp-webhook` em modo `_test` (roda o cérebro
inteiro: Claude, carrinho, cadastro, CEP, fechar pedido) → devolve a resposta pela Graph API.
**O cérebro não é duplicado e o Evolution não é tocado.** Trata texto, botões/listas e áudio
(baixa da Graph API e transcreve no Whisper).

## ✅ TESTADO E FUNCIONANDO — 08/08/2026 01:53

Primeiro "oi" real respondido pela Cloud API, sem o Evolution em nenhum ponto:

| Hora | Quem | Mensagem |
|---|---|---|
| 01:53:17.15 | cliente (`558498180774`) | `oi` |
| 01:53:17.53 | robô | "😴 Estamos fechados no momento! Hoje atendemos das *07:00* às *14:00*…" + link da loja online |

Ida e volta em **~380 ms**; a função respondeu `200` em 281 ms. O cérebro rodou completo
(inclusive a grade de horário da loja), provando o desenho de reaproveitar o
`whatsapp-webhook` em modo `_test`.

### ⚠️ A pegadinha que travou o primeiro teste

O primeiro "oi" **não gerou nenhuma invocação** da função — a mensagem morria na Meta.
Causa: o toggle **"Assinar webhooks"** da WABA estava **desligado**.

Configurar o webhook no app **não basta**: cada WABA precisa assinar o app separadamente. A
WABA de teste já vinha assinada porque nasceu dentro do app; a `FWC Inter` foi criada pelo
Gerenciador de Negócios e nasceu solta.

**Onde liga:** painel do app → WhatsApp → *Etapa 2. Configuração da produção* → *Registre seu
número de telefone do WhatsApp* → toggle **"Assinar webhooks"** ao lado do nome da WABA.

Sintoma para reconhecer o problema de novo: **zero linhas** de `whatsapp-cloud` no
`get_logs`. Se a função for invocada mas não responder, o problema é outro (envio/token).

Obs.: o envio funcionou sem precisar atribuir a WABA ao usuário de sistema `botatende` —
o token do app já deu conta. Não mexer no que está funcionando.

### Feito em 08/08/2026 ✅

1. **Forma de pagamento cadastrada** — MasterCard ···· 7010 na conta da WABA `FWC Inter`,
   **Brasil / Dólar americano (USD)**, fuso São Paulo. Foi USD porque o Real não é oferecido
   (ver a seção "A moeda não deixa escolher Real" logo abaixo). Decisão do usuário: abrir em
   USD agora e migrar para BRL depois, dentro do prazo da Meta.
2. **Template `cobranca_mensalidade` enviado para análise** — categoria **Utilidade**,
   idioma **Portuguese (BR)**, status **Em análise**. Texto:

   > Olá {{1}}, aqui é a FWC Inter. Sua fatura de {{2}}, no valor de {{3}}, vence em {{4}}.
   > Responda esta mensagem se precisar do código PIX ou da segunda via.

   Variáveis: {{1}} nome da loja, {{2}} mês de referência, {{3}} valor, {{4}} vencimento.
   Amostras usadas na análise: `Estação do Sabor`, `agosto/2026`, `R$ 149,90`, `15/08/2026`.

**⚠️ Pegadinha do template (guardar):** ao enviar, a Meta abre o diálogo **"A categoria não
corresponde"** com Marketing marcado como *Recommended* e o aviso **"Este modelo de mensagem
será rejeitado"**. O primeiro texto (*"É só responder esta mensagem que eu te mando o PIX na
hora"*) foi classificado como Marketing. Reescrever em linguagem de fatura — "aqui é a FWC
Inter", "sua fatura de", "segunda via" — passou direto, sem o diálogo. Sintoma de que o envio
não concluiu: o botão fica em *Carregando* para sempre porque o diálogo está esperando
resposta atrás da tela.

### Falta ❌

1. **Trocar os disparos de texto livre por template** depois que o `cobranca_mensalidade`
   for aprovado (começar pelo `admin-alertas`).

## A moeda não deixa escolher Real (apurado 08/08/2026)

Em *Cobrança e pagamentos → Contas do WhatsApp Business → Adicionar forma de pagamento*, o
modal abre com País = **Brasil** e Moeda = **Dirham dos EAU**, e a lista tem **15 moedas sem
o Real**: Dirham EAU, Dólar americano/australiano/de Singapura, Euro, Libra esterlina, Novo
Sol peruano, Peso argentino/chileno/colombiano/mexicano, Rial saudita, Ringgit malaio, Rupia
indiana, Rúpia indonésia. **A lista é fixa — não muda ao trocar o país** (testado indo para
Argentina e voltando). O aviso *"A localização e a moeda não poderão ser alteradas após serem
definidas"* é para valer.

Motivo: desde **01/07/2026** a Meta só permite WABA em BRL para quem tem **Sold-To country =
Brasil no Billing Hub**, que na prática é fatura mensal com linha de crédito paga por **boleto
pela Facebook Brasil**. Em *Linhas de crédito* o painel diz "Nenhuma linha de crédito foi
alocada" e **"A opção de pedir acesso a esta página não está mais disponível"** — não sai por
autosserviço. Quem é elegível a BRL tem que migrar até **30/06/2027**; a partir de
**01/07/2027** a Meta **para de entregar** mensagens de WABA fora de BRL. Há APIs de migração
de moeda desde 01/06/2026, então dá para abrir em USD agora e migrar depois.

Corrigido no caminho: o Billing Hub acusava **"Permissões de edição ausentes"** — resolvido em
*Linhas de crédito → Modificar permissões → Atribuir a mim* ("Você se tornou editor
financeiro"). Era bloqueio real para mexer em cobrança, mas **não** era a causa da falta do
BRL — a lista continuou sem Real depois.

**Nada disso trava o robô:** mensagem do cliente para a empresa **não é cobrada** e **template
de utilidade dentro da janela de atendimento aberta é grátis**. Só custa o template disparado
**fora** da janela de 24h — a cobrança de mensalidade.

## A regra das 24 horas (importante)

Na Cloud API, **texto livre só sai dentro de 24h** desde a última mensagem do destinatário.
Fora da janela, só passa **template aprovado**.

Isso significa que o bot funciona de graça e sem template (o cliente sempre manda "oi"
primeiro), mas **todo envio iniciado pela FWC precisa de template**. Hoje mandam texto livre:

| Função | O que manda | Pra quem |
|---|---|---|
| `resumo-diario` | resumo do dia | `empresas.telefone_contato` |
| `admin-alertas` | alerta de mensalidade | super admin |
| `alertas-loja` | alertas operacionais | lojista |
| `notify-admin` | texto livre | qualquer número |
| `mercadopago-webhook` | aviso de pagamento | lojista |

**Objetivo do usuário para este número: disparo de cobrança de mensalidade aos clientes.**
Cobrança de mensalidade cai na categoria **Utilidade** — a mais barata e a de aprovação mais
rápida. Rascunho do template:

> Olá {{1}}! Sua mensalidade FWC Inter de {{2}} no valor de {{3}} vence em {{4}}.
> Para pagar, é só responder esta mensagem.

Depois de aprovado, trocar o `admin-alertas` (e depois os outros) para disparar template em
vez de texto livre pelo Evolution.

### Sobrou de teste

A WABA de teste `Test WhatsApp Business Account` (id `1710227020074071`, número
`+1 555-148-0029`) segue existindo e está apontada na loja **CDBom**
(`cloud_phone_number_id = 1135024189705181`). Usar ela — ou uma conta de sandbox — para
qualquer experimento, nunca a WABA de produção.

---

## Decisões tomadas

1. **O (84) 99818-0774 NÃO vai pra Cloud API.** Ele é o `super_admin_phone` e o WhatsApp
   humano da FWC. Um número está *ou* no app *ou* na Cloud API — nunca nos dois. Perder o
   canal humano não compensa (o número anterior, 99928-1009, já foi bloqueado).
2. **Linha nova, barata, só pro robô.** O chip só precisa funcionar **uma vez**, pra receber
   o código de verificação; depois o número vive nos servidores da Meta. Pré-pago de
   operadora real resolve. Manter a linha ativa (recarga mínima) pra não ser reciclada.
3. **Nada de teste na conta de produção.** Ban escala número → WABA → portfólio, e a FWC já
   perdeu um portfólio de forma permanente. Teste vai no número de teste ou numa conta de
   sandbox ("Reivindicar conta de sandbox" no painel do app).

### Comprando o chip

- Operadora de verdade (Vivo/Claro/TIM). **Nada de número virtual/VoIP** — a Meta bloqueia
  boa parte dessas faixas.
- Precisa receber SMS ou chamada.
- Se possível, ativar no CNPJ da FWC (66.437.917/0001-66).
- Evitar número "bonito" (0000, 1111, 1234) — são os mais reciclados.
- **NÃO instalar o WhatsApp normal no chip.** Chip novo ≠ número novo: operadoras reciclam
  números inativos depois de ~90 dias e o histórico de denúncia fica no número. Foi isso que
  derrubou o chip anterior (entrou em análise 5 vezes seguidas). Além disso, pra entrar na
  Cloud API o número precisa estar livre do app.

---

## Passo a passo quando o chip chegar

1. **Criar a WABA real**
   Gerenciador do WhatsApp → adicionar conta do WhatsApp Business (não usar a de teste).

2. **Adicionar o número e verificar**
   Recebe o código por SMS ou chamada. Definir e **anotar o PIN de 6 dígitos** (verificação
   em duas etapas).

3. **Atribuir a WABA ao usuário do sistema `botatende`** ⚠️
   Configurações → Usuários do sistema → `botatende` → Ativos atribuídos → Contas do WhatsApp
   → adicionar a WABA nova com **controle total**.
   Hoje o `botatende` só tem o *App* atribuído, nenhuma Conta do WhatsApp. Sem esse passo o
   token permanente não consegue enviar pela WABA nova.

4. **Conferir a forma de pagamento**
   A Cloud API cobra por conversa acima da cota gratuita. Verificar se a conta de pagamento
   está em **Brasil/BRL** — na navegação apareceu uma seção "Índia" em Configurações de
   pagamento, precisa ser checado.

5. **Gravar os dados no banco**
   ```sql
   update whatsapp_config
      set cloud_phone_number_id = '<PHONE_NUMBER_ID>',
          cloud_waba_id         = '<WABA_ID>',
          cloud_display_number  = '<+55 84 9xxxx-xxxx>',
          cloud_pin             = '<PIN 6 dígitos>',
          cloud_verified_name   = 'FWC Inter'
    where empresa_id = '<uuid da loja>';
   ```

6. **Testar**
   Mandar "oi" pro número novo. Acompanhar em
   `supabase functions logs whatsapp-cloud` (ou `get_logs` no MCP) e olhar
   `[cloud send] erro` / `[cloud] nenhuma loja para phone_number_id`.

7. **Avisar os clientes**
   Disparo do 99818-0774 informando o número novo do robô.

---

## Coexistência — a loja NÃO precisa perder o WhatsApp dela

Pesquisado na documentação oficial em 08/08/2026. **Confirmado que está liberado na nossa
conta**: no *Configurador de cadastro incorporado* → campo **"Tipo de recurso"** aparece a
opção **"Integração do app WhatsApp Business"** (é a coexistência). Requer ser Provedor de
Tecnologia — nós somos.

Sem coexistência, o número sai do app do celular (foi o que aconteceu com o número da FWC).
Com coexistência, o dono continua usando o **WhatsApp Business** no celular E o robô funciona
no mesmo número. Isso derruba a maior objeção de venda: *"não quero abrir mão do meu zap que
já tem cliente"*.

### A loja mantém
- O app WhatsApp Business funcionando normalmente no celular
- Histórico dos últimos **6 meses** sincronizado (se autorizar)
- Todos os contatos sincronizados
- Mensagens espelhadas nos dois sentidos (API ↔ app)
- Editar/apagar mensagem
- Mensagem enviada pelo app continua **grátis** e não cria/estende a janela de 24h da API

### Limitações
| Item | O que acontece |
|---|---|
| App | Tem que ser o **WhatsApp Business** v2.24.17+. O WhatsApp **comum não serve** |
| **Listas de transmissão** | Viram **somente leitura** — não cria novas |
| Mensagens temporárias / ver uma vez / localização ao vivo | Desligadas nas conversas 1:1 |
| Grupos | Não sincronizam com a API |
| Catálogo, pedidos, etiquetas, respostas rápidas, saudação/ausência | Continuam só no app, não gerenciáveis pela API |
| Aparelhos conectados (WhatsApp Web etc.) | **Desconectam uma vez** no onboarding; dá pra reconectar depois |
| Windows / WearOS | Não suportados |
| Chamada de voz/vídeo | Não existem na API (no app seguem normais) |
| Throughput | Fixo em **20 msg/s** (1.200/min — folgado pro nosso uso) |
| Sincronização do histórico | A loja tem **24h** pra concluir, senão precisa refazer o flow |
| Cliente que escreve antes do onboarding terminar | Só dá pra responder com template (não há janela aberta) |

A perda da lista de transmissão é o único ponto que dói — e é justamente o que fazia a loja
tomar ban. Em troca ela ganha o disparo oficial por template. Vira argumento de venda.

Fontes:
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
- https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/

## Fase 2 — Cadastro Incorporado (as lojas)

Com o Provedor de Tecnologia verificado, dá pra fazer o modelo SaaS certo: a loja clica em
"Conectar meu WhatsApp" no gestor, loga no Facebook dela e pluga o número próprio. Cada loja
com o número dela, a FWC não gerencia número de ninguém, e o risco de ban some.

Ponto de partida: `supabase/functions/whatsapp-cloud-signup/index.ts` e o
"Configurador de cadastro incorporado" no painel do app.

Atenção nesse modelo: o token deixa de ser um só (o do `botatende`) e passa a ser **um por
cliente**, trocado no fluxo do OAuth. O `whatsapp-cloud` vai precisar buscar o token da loja
no banco em vez de usar o `WHATSAPP_CLOUD_TOKEN` global.

---

## Referências

- Painel do app: https://developers.facebook.com/apps/2285733882190923/whatsapp-business/wa-tools/?business_id=1186584751211342
- Análise do app: https://developers.facebook.com/apps/2285733882190923/app-review/submissions/?business_id=1186584751211342
- Números de telefone: https://business.facebook.com/latest/whatsapp_manager/phone_numbers/?business_id=1186584751211342
- Usuários do sistema: https://business.facebook.com/latest/settings/system_users?business_id=1186584751211342
