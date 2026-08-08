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

### Falta ❌

1. **Atribuir a WABA `FWC Inter` ao usuário de sistema `botatende`** com controle total.
   Sem isso o token permanente não envia por ela e o log só mostra um `[cloud send] erro`
   genérico. Caminho: Usuários do sistema → `botatende` → Ativos atribuídos → Gerenciar →
   Contas do WhatsApp → FWC Inter.
2. **Forma de pagamento.** Nenhuma cadastrada. ⚠️ A conta de cobrança mostra saldo em `$` e
   moeda vazia — **a moeda trava no momento do cadastro e não muda depois**. Conferir que
   está **BRL** antes de confirmar o cartão.
3. **Templates para a cobrança de mensalidade** (ver seção abaixo).

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
