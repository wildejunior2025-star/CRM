# 🍽️ Serviço Presencial — Roadmap

Módulo de atendimento no local (mesas, comandas, cozinha) dentro do CRM.
Acesso: menu **Operações → Serviço Presencial**.

Legenda: ✅ feito e testável · 🔨 em desenvolvimento · 🔜 próximo · 💡 ideia (fase 2)

## Fundação
| # | Item | Status | Onde |
|---|------|--------|------|
| 0.1 | Config na empresa (`presencial_ativo`, `taxa_servico_pct`) | ✅ | migration 0049 |
| 0.2 | Menu "Serviço Presencial" em Operações (com sub-categorias) | ✅ | Layout |
| 0.3 | Página principal (visão geral + ligar módulo + taxa de serviço) | ✅ | /presencial |

## Núcleo (MVP)
| # | Item | Status | Onde |
|---|------|--------|------|
| 1.1 | **Cadastro de mesas** (criar, editar, ativar, remover) | ✅ | /presencial/mesas |
| 1.2 | **Salão / mapa de mesas** (abrir, ocupar, status ao vivo) | ✅ | /presencial/salao |
| 1.3 | **Comanda da mesa** (lançar itens ao longo do tempo) | ✅ | dentro do Salão |
| 1.4 | **Fechar conta** (subtotal + taxa de serviço + forma pgto, libera a mesa) | ✅ | dentro do Salão |
| 1.4b | Baixa de estoque + venda/recebimento no Caixa ao fechar a conta | ✅ | migration 0052 |
| 1.5 | Lançar pedido pelo **celular do garçom** (mesma tela do Salão, responsiva) | ✅ | /presencial/salao |

## Cozinha & Autoatendimento
| # | Item | Status | Onde |
|---|------|--------|------|
| 2.1 | **KDS** — painel de preparo ao vivo | ✅ | /presencial/cozinha |
| 2.2 | Impressão automática na cozinha | 💡 | — |
| 2.3 | **QR Code na mesa** — cliente pede sozinho, vai direto pra cozinha | ✅ | /mesa/:token · migration 0055 |

## Fechamento avançado
| # | Item | Status |
|---|------|--------|
| 3.1 | Dividir conta (rachar igual 2x/3x/4x ou valores manuais) | ✅ |
| 3.2 | Juntar / transferir mesa | 💡 |
| 3.3 | Pagamento parcial / múltiplas formas (parte PIX, parte dinheiro) | ✅ |
| 3.4 | Integração com **pontos/fidelidade** (ganhar e usar saldo) | 💡 |

## Diferenciais (fase 2)
| # | Item | Status |
|---|------|--------|
| 4.1 | Reservas | 💡 |
| 4.2 | Fila de espera (aviso por WhatsApp) | 💡 |
| 4.3 | Comissão por garçom | 💡 |
| 4.3 | Atribuição de entrega por item (quem entregou cada prato) | ✅ |
| 4.4 | Relatórios de salão — ranking de entregas/garçom hoje ✅; giro/ticket/pico 💡 | parcial |
| 4.5 | Modo balcão/fast (comanda por senha) | 💡 |

---
_Atualizado conforme as entregas. Cada item ✅ já dá pra testar no app._
