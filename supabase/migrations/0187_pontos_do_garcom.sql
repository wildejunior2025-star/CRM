-- 0187_pontos_do_garcom.sql
-- Pontos por AÇÃO, no lugar de "dono da mesa".
--
-- O ranking por quem ABRIU a mesa amarra o atendimento: o garçom precisa
-- carregar aquela mesa até o fim pra levar o crédito, e nasce o "não mexe na
-- minha mesa" — que é exatamente o que trava o salão. Contando cada gesto,
-- qualquer um atende qualquer mesa e cada um leva o que fez.
--
-- Entregar já era registrado (comanda_itens.entregue_por). Faltavam os outros
-- dois: quem LANÇOU o item e quem FECHOU a conta. Dado que não é gravado na
-- hora não volta depois.

ALTER TABLE public.comanda_itens
  ADD COLUMN IF NOT EXISTS lancado_por uuid REFERENCES public.profiles(id);

COMMENT ON COLUMN public.comanda_itens.lancado_por IS
  'Quem mandou este item pra cozinha. Preenchido pelo gatilho a partir do auth.uid() (mig 0187).';

ALTER TABLE public.comandas
  ADD COLUMN IF NOT EXISTS fechada_por    uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS fechada_por_em timestamptz;

COMMENT ON COLUMN public.comandas.fechada_por IS
  'Quem fechou a conta (o garçom que mandou pra conferência, ou o ADM que fechou direto). Não é quem liberou a mesa (mig 0187).';
COMMENT ON COLUMN public.comandas.fechada_por_em IS
  'Quando fechou. Existe separado de fechada_at porque a conta do garçom fica em conferência antes de virar venda (mig 0187).';

-- Quanto vale cada gesto. A loja decide; o padrão trata lançar e entregar por
-- igual e paga um pouco mais por fechar conta (é onde mexe dinheiro).
ALTER TABLE public.empresas
  ADD COLUMN IF NOT EXISTS pontos_garcom jsonb NOT NULL
    DEFAULT '{"lancar": 1, "entregar": 1, "fechar": 2}'::jsonb;

COMMENT ON COLUMN public.empresas.pontos_garcom IS
  'Peso de cada gesto no ranking do garçom: lancar, entregar, fechar (mig 0187).';

-- O gatilho que já carimbava o setor carimba também quem lançou. Um gatilho só
-- porque é o mesmo momento (INSERT do item) e todo caminho passa por ele: tela
-- do Salão, celular do garçom, app.
CREATE OR REPLACE FUNCTION public.comanda_item_setor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_cat   text;
  v_setor text;
BEGIN
  IF NEW.lancado_por IS NULL THEN NEW.lancado_por := auth.uid(); END IF;

  IF NEW.setor IS NOT NULL AND NEW.setor <> 'salao' THEN RETURN NEW; END IF;
  NEW.setor := 'salao';
  IF NEW.produto_id IS NULL THEN RETURN NEW; END IF;

  BEGIN
    SELECT categoria INTO v_cat FROM produtos WHERE id = NEW.produto_id::uuid;
  EXCEPTION WHEN others THEN
    RETURN NEW;
  END;
  IF v_cat IS NULL THEN RETURN NEW; END IF;

  SELECT c.setor INTO v_setor
  FROM categorias c
  WHERE c.empresa_id = NEW.empresa_id
    AND lower(unaccent(btrim(c.nome))) = lower(unaccent(btrim(v_cat)))
  LIMIT 1;

  IF v_setor IS NOT NULL THEN NEW.setor := v_setor; END IF;
  RETURN NEW;
END;
$fn$;

NOTIFY pgrst, 'reload schema';
