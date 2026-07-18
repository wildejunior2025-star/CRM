-- Repasse REAL do iFood, importado da planilha de pedidos (Financeiro -> exportar .xlsx).
-- Guarda o valor exato por dia e serve pra calibrar a taxa de cada loja
-- (cada loja tem um plano de comissão diferente no iFood).

-- Taxas calibradas por loja a partir da planilha. NULL = usa o padrão do sistema.
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS ifood_comissao_pct  numeric,
  ADD COLUMN IF NOT EXISTS ifood_transacao_pct numeric;

CREATE TABLE IF NOT EXISTS public.ifood_repasses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES public.empresas(id) ON DELETE CASCADE,
  dia              date NOT NULL,
  pedidos          int     NOT NULL DEFAULT 0,
  vendas           numeric NOT NULL DEFAULT 0,   -- total pago pelo cliente
  itens            numeric NOT NULL DEFAULT 0,
  taxas            numeric NOT NULL DEFAULT 0,   -- taxas e comissões (guardado positivo)
  valor_liquido    numeric NOT NULL DEFAULT 0,   -- repasse real do iFood
  recebido_entrega numeric NOT NULL DEFAULT 0,   -- bruto pago na entrega (pra bater o caixa)
  importado_em     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, dia)
);

ALTER TABLE public.ifood_repasses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Super admin gerencia repasses ifood"
  ON public.ifood_repasses
  FOR ALL USING (current_perfil() = 'super_admin')
  WITH CHECK (current_perfil() = 'super_admin');

CREATE POLICY "Loja gerencia seus repasses ifood"
  ON public.ifood_repasses
  FOR ALL USING (empresa_id = current_empresa_id())
  WITH CHECK (empresa_id = current_empresa_id());
