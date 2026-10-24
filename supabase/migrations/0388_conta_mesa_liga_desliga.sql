-- ─────────────────────────────────────────────────────────────────────────────
-- 0388 — Chave da loja: imprimir ou não a CONTA quando fecha a mesa/comanda
--
-- Irmã da 0386 (cupom do balcão), e a que o lojista queria de verdade: o papel
-- que sai "comprovando a forma de pagamento e o pedido finalizado" é a CONTA do
-- fechamento da comanda, não o cupom da venda do balcão. São dois papéis e dois
-- caminhos diferentes — a conta nem passa pela `reservar_impressao`, ela é
-- montada na tela e mandada pro app FWC com `origem: 'mesa'`.
--
-- Por isso esta chave é lida no FRONT (Salão e Painel de Pedidos), nos pontos
-- em que a conta sai SOZINHA:
--   • ADM fecha e libera a mesa;
--   • garçom manda pro caixa (mesa azul);
--   • mesa que fechou sozinha quando o PIX caiu;
--   • Painel imprimindo a conta de quem acabou de entrar em conferência.
--
-- CONTINUAM IMPRIMINDO, de propósito (são pedidos de gente, não automação):
-- o botão "Imprimir conta" da mesa aberta, o "Reenviar conta" da mesa azul,
-- a segunda via pedida por outro aparelho e a pré-conta.
--
-- Padrão `true`: ninguém sente diferença até a loja desligar.
-- ─────────────────────────────────────────────────────────────────────────────

alter table empresas
  add column if not exists imprimir_conta_mesa boolean not null default true;

comment on column empresas.imprimir_conta_mesa is
  'false = a conta não sai no papel sozinha ao fechar a mesa/comanda (vale pra loja toda; os botões de imprimir/reenviar conta continuam valendo).';
