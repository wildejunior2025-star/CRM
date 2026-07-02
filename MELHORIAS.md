# Backlog de Melhorias — CRM FWC Inter

> Lista viva. Vamos marcando o Status conforme conclui. Ordem de ataque: **Entregador primeiro**.
> Legenda Status: ⬜ a fazer · 🔧 em andamento · ✅ feito

## 🛵 Entregador (app do motoqueiro)

| ID | Melhoria | Detalhe / o que fazer | Complex. | Status |
|----|----------|-----------------------|----------|--------|
| E1 | Rota completa no app | Montar a rota já partindo da localização atual do motoqueiro; quando ele tiver mais de uma entrega, gerar **rota com várias paradas** numa navegação só (Google Maps/Waze) | Média | ✅ |
| E2 | "PAGO" bem visível + taxa da corrida | Deixar claro pro entregador que o pedido **já está pago** (destaque forte, não só texto pequeno) e mostrar a **taxa de entrega de cada corrida** | Baixa | ✅ |
| E3 | Desistir da entrega aceita | Botão no app do entregador pra **largar/devolver** uma entrega que ele já aceitou (volta pro pool de disponíveis) | Baixa | ✅ |
| E4 | Fila por ordem de chegada (ON/OFF) | Motoqueiro tem botão **Online/Offline**. Só vê pedidos quando está **ON**. Ao clicar ON, **entra na fila por ordem de chegada**. Só o da vez aceita. Botão **Finalizar minha vez** → pausa e passa pro próximo; **Voltar pra fila** entra no fim. Liga/desliga por loja em **Funcionários** | Alta | ✅ |
| E5 | Desconto opcional por entrega | **Opcional por loja.** No **cadastro do entregador**, um **toggle ao lado do nome**: se ligado, a loja define um **valor a descontar dele por cada entrega** (ex: R$1). Entra no acerto/relatório | Média | ✅ |

## 🍔 iFood (ligado ao entregador)

| ID | Melhoria | Detalhe / o que fazer | Complex. | Status |
|----|----------|-----------------------|----------|--------|
| F1 | Confirmar entrega do iFood pelo nosso sistema | **FEITO e VALIDADO (02/07):** motoqueiro digita o código do cliente → `verifyDeliveryCode` → iFood conclui. Poll detecta `DDCR` e marca o pedido (mig 0085/0086 + edge). **Testado no ambiente-teste:** pedido #6157 despachado → DDCR detectado (`ifood_requer_codigo=true`) → endpoint respondeu com auth válida. **NÃO precisa de homologação nova** (roda no crm-fwc já aprovado). Só falta ver o `valid:true` com o código certo | Alta | ✅ |
| F2 | Ligar pro Localizador do iFood (0800) | **FEITO:** no app do motoqueiro, pedidos iFood **não mostram WhatsApp**; o botão 📞 liga direto no 0800 do iFood e exibe o **ID** (localizer) pra digitar. Guardamos o `ifood_phone_localizer` (mig 0084 + edge fn) | Baixa | ✅ |
| F3 | Pausar/esgotar item no iFood + cardápio | **CÓDIGO PRONTO (02/07):** edge `catalogo_listar`/`catalogo_pausar` (PATCH items/status) + tela em Minha Loja → Integração iFood ("Pausar itens no iFood"). **Aguardando:** ticket de homologação do módulo Catálogo (Em análise) + reunião + Zebu autorizar scope catálogo. Testar na reunião | Média | 🔧 |

## 🧑‍🍳 Cozinha / Gestor

| ID | Melhoria | Detalhe / o que fazer | Complex. | Status |
|----|----------|-----------------------|----------|--------|
| G1 | Cozinha: "Aceitar" antes do "Pronto" | **FEITO:** no KDS, botão **Aceitar** trava o pedido/item na pessoa (`preparando_por`, mig 0088). Mostra "👨‍🍳 Você está preparando" / "🔒 Fulano está preparando"; **só quem aceitou** vê o Pronto (+ botão Soltar). Cada cozinheiro com login próprio | Média | ✅ |
| G2 | Gestor não mostra nada pro atendente | **CORRIGIDO:** faltava policy de RLS pro perfil **vendedor** em `pedidos_delivery` (quadro abria vazio). Migration 0083 dá ao vendedor os poderes do admin, restritos à empresa | Feito | ✅ |
| G3 | Mesa concluída não fica no gestor | **CORRIGIDO:** mesa fechada virava venda e sumia do quadro. Agora as **mesas fechadas hoje** aparecem na coluna "Concluídos hoje" (contagem incluída) | Feito | ✅ |

## 📦 Produtos

| ID | Melhoria | Detalhe / o que fazer | Complex. | Status |
|----|----------|-----------------------|----------|--------|
| P1 | Produto "self service" (valor fixo) | Produto **self service de preço fixo** (cliente se serve e paga valor fixo). **Sem peso/kg** nessa loja | Baixa | ⬜ |

---

### Decisões (respondidas 02/07)
- **E4:** fila por **ordem de chegada** = ordem em que o motoqueiro clica **Online**. Precisa de estado ON/OFF: loja só distribui se **aberta**, motoqueiro só vê pedidos se **ON**. Quem está na vez pode **passar pro próximo**.
- **E5:** desconto **opcional**, ligado por entregador no cadastro (toggle ao lado do nome) + valor por entrega definido pela loja.
- **P1:** **valor fixo**, sem peso. Nessa loja não tem venda por quilo.
