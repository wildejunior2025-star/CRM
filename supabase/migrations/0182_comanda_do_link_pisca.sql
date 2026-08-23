-- Pedido pelo link do cliente cai como comanda nova e ninguém avisa a loja.
-- Numa casa com dez mesas abertas isso passa batido — o cliente está na frente
-- do balcão esperando e o pedido dele fica parado na tela.
--
-- `visto_em` marca quando alguém da loja OLHOU a comanda. Nasce preenchida por
-- padrão, então comanda aberta pelo próprio atendente já nasce vista: só o
-- pedido que chega de fora (pelo link) entra com NULL e fica piscando.
--
-- É `visto_em IS NULL` e não um booleano `visto` porque a loja vai querer saber
-- QUANTO TEMPO o pedido ficou esperando alguém olhar — é a única medida de
-- atendimento que existe aqui.
--
-- (Também aplicado no banco: `marcar_comanda_vista` e o `cliente_pedir`
--  gravando NULL, inclusive quando o cliente acrescenta item numa comanda que
--  já estava aberta — item novo pra cozinha, e ninguém viu ainda.)
ALTER TABLE public.comandas
  ADD COLUMN IF NOT EXISTS visto_em timestamptz DEFAULT now();
