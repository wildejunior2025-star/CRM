# 🏘️ Melhoria: Taxa de entrega por BAIRRO (fazer fora do movimento)

> Objetivo: cobrar **taxa** e **tempo** de entrega **por bairro**, no lugar (ou além) do cálculo por km de hoje.
> Modelo escolhido: **HÍBRIDO** — bairro cadastrado usa o preço do bairro; bairro fora da lista cai no cálculo por km atual (nunca fica sem taxa).

## ✅ Checklist do que fazer

- [ ] **1. Puxar os bairros automaticamente**
  - Puxar os bairros dos pedidos passados (`pedidos_delivery.endereco_bairro`).
  - **Agrupar as variações** do mesmo bairro (ignorar acento / maiúscula / abreviação). Ex: "Nossa Sra. da Apresentação", "Nossa Senhora da Apresentação", "Ns Apresentacao" = **1 bairro só**.
  - (Opcional) somar sugestões do mapa (OpenStreetMap) dentro do raio da loja.

- [ ] **2. Tela de configuração** (dentro de "Raio de Entrega")
  - Lista dos bairros; para cada um, 3 opções:
    - ✅ **Entrega** → campos **Taxa (R$)** e **Tempo (min)**
    - 🚫 **Não entrego** → bloqueia
    - (não marcado / fora da lista) → cai no cálculo por km
  - O dono só marca o que entrega e digita taxa + tempo. Salva.

- [ ] **3. Guardar a config nova**
  - Novo campo na tabela `empresas` (ex: `taxas_entrega_bairro`): lista de `{ bairro, taxa, tempo, entrega: true/false }`.

- [ ] **4. Usar a taxa por bairro no cálculo (3 lugares)** — checar bairro primeiro (normalizado); se não achar, usa km:
  - [ ] Cardápio online (`DeliveryCheckout`)
  - [ ] Robô do WhatsApp (`supabase/functions/whatsapp-webhook` → `calcularTaxaEntregaKm`)
  - [ ] Qualquer outro ponto que calcule a taxa

- [ ] **5. Bloqueio "Não entrego"**
  - Site e WhatsApp: quando o bairro do cliente for bloqueado → avisar *"Poxa, ainda não entregamos no seu bairro 😔"* e **não deixar finalizar** a entrega (oferecer retirada, se ativa). Barrar **antes** de fechar o pedido.

- [ ] **6. Função de normalização de bairro (compartilhada)**
  - Tira acento/maiúscula/espaços pra **casar** o bairro do cliente com o da lista. Usar a MESMA função na hora de puxar (passo 1) e na hora de cobrar (passo 4).

- [ ] **7. Fallback (híbrido)**
  - Bairro desconhecido / fora da lista → usa o cálculo por km de hoje.

- [ ] **8. Testar**
  - Pedido de bairro COM taxa cadastrada (cobra certo).
  - Pedido de bairro **bloqueado** (avisa e não deixa).
  - Pedido de bairro **fora da lista** (cai no km).

## 📌 Observações
- Fazer **fora do horário de pico** — mexe em pontos sensíveis (cardápio, WhatsApp, checkout).
- Config atual da Zebu hoje é por km (faixas em `empresas.taxas_entrega_km`), raio de 10 km.
- Os bairros reais mais pedidos da Zebu (base pra começar): Nossa Sra. da Apresentação, Potengi, Igapó, Pajuçara, Amarante, Lagoa Azul, Golandim, Redinha, Jardins, Novo Amarante, Jardim Lola, São Gonçalo do Amarante.
