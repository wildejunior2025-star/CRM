-- =========================================================
-- 0126: Loja pode não trabalhar com estoque
-- =========================================================
-- Restaurante não conta estoque de "Bauru simples" nem de "Cuscuz na manteiga":
-- ele compra insumo, não unidade pronta. Só que toda venda descontava do
-- estoque assim mesmo, então a tela ficava com saldo negativo em tudo (-5, -4)
-- e o status "Estoque baixo" em cada linha — um alarme falso que o dono
-- aprendia a ignorar.
--
-- Agora existe um interruptor por loja: empresas.estoque_ativo. Desligado, a
-- loja some com a parte de estoque e NENHUM movimento é gravado.
--
-- O bloqueio é num trigger na estoque_movimentos, não dentro de cada função.
-- São 4 caminhos que descontam estoque hoje (registrar_venda,
-- registrar_pedido_portal, cancelar_venda, fechar_conta_presencial) e só 1
-- deles checava o controla_estoque do produto — no trigger, qualquer caminho
-- novo já nasce respeitando a escolha da loja.
-- =========================================================

ALTER TABLE empresas
  ADD COLUMN IF NOT EXISTS estoque_ativo boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN empresas.estoque_ativo IS
  'false = a loja não trabalha com estoque: nenhum movimento é gravado e a tela de Estoque fica desligada.';

CREATE OR REPLACE FUNCTION public.ignorar_estoque_loja_desligada()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_empresa uuid;
  v_ativo   boolean;
BEGIN
  v_empresa := COALESCE(NEW.empresa_id, (SELECT empresa_id FROM produtos WHERE id = NEW.produto_id));

  SELECT estoque_ativo INTO v_ativo FROM empresas WHERE id = v_empresa;

  -- Só descarta quando a loja disse explicitamente que não usa estoque.
  -- Empresa não encontrada (v_ativo NULL) grava normal — o padrão é permitir.
  IF v_ativo IS FALSE THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ignorar_estoque_loja_desligada ON estoque_movimentos;
CREATE TRIGGER trg_ignorar_estoque_loja_desligada
  BEFORE INSERT ON estoque_movimentos
  FOR EACH ROW EXECUTE FUNCTION public.ignorar_estoque_loja_desligada();
