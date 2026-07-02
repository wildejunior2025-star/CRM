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
| F1 | Confirmar entrega do iFood pelo nosso sistema | Ver se dá pra **confirmar o pedido do iFood direto pela nossa tela de entrega**. Se não der pela API, mostrar pro motoqueiro o **código/Localizador** (ex: `1451 8048`) pra ele confirmar no app do iFood dele | Alta | ⬜ |
| F2 | Ligar pro Localizador do iFood (0800) | Botão pra **ligar direto no 0800 do iFood** informando o Localizador da corrida | Baixa | ⬜ |
| F3 | Pausar/esgotar item no iFood + cardápio | Pelo nosso gestor, **pausar (marcar esgotado) um item** e refletir tanto no **iFood** quanto no **nosso cardápio** | Média | ⬜ |

## 🧑‍🍳 Cozinha / Gestor

| ID | Melhoria | Detalhe / o que fazer | Complex. | Status |
|----|----------|-----------------------|----------|--------|
| G1 | Cozinha: "Aceitar" antes do "Pronto" | Hoje só tem **Pronto**. Adicionar um **Aceitar** primeiro, que **trava o pedido** pra 2 pessoas não pegarem/prepararem o mesmo pedido ao mesmo tempo | Média | ⬜ |
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
