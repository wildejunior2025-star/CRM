-- 0184_setor_cozinha_salao.sql
-- Cada item da comanda sabe se é da COZINHA ou do SALÃO.
--
-- Pra loja com duas térmicas: a da cozinha imprime só o que vai ser preparado;
-- a da frente imprime o resto (bebida, sobremesa pronta) mais conta, pré-conta
-- e fechamento. Hoje a comanda sai inteira nas duas, e a cozinha recebe pedido
-- de refrigerante — papel à toa e gente parando pra ler o que não é dela.
--
-- A marcação é na CATEGORIA, não no produto: o lojista marca "Quentinhas" e
-- "Tapioca" como cozinha uma vez, e todo produto delas vai junto. A regra é
-- SALÃO SAI TUDO, MENOS O QUE É DA COZINHA — por isso o padrão é 'salao' e só
-- a cozinha precisa ser marcada. Categoria nova nasce no salão e ninguém fica
-- sem ver o pedido enquanto não configura nada.

ALTER TABLE public.categorias
  ADD COLUMN IF NOT EXISTS setor text NOT NULL DEFAULT 'salao';

DO $$ BEGIN
  ALTER TABLE public.categorias
    ADD CONSTRAINT categorias_setor_ck CHECK (setor IN ('salao', 'cozinha'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.categorias.setor IS
  'cozinha = os itens desta categoria vão pra impressora da cozinha. salao (padrão) = vão pra da frente (mig 0184).';

-- O setor fica GRAVADO no item, não é calculado na hora de imprimir. Assim a
-- comanda de ontem continua contando a verdade de ontem mesmo que a loja mude
-- a categoria de setor hoje.
ALTER TABLE public.comanda_itens
  ADD COLUMN IF NOT EXISTS setor text NOT NULL DEFAULT 'salao';

COMMENT ON COLUMN public.comanda_itens.setor IS
  'Copiado da categoria do produto no momento do pedido, pelo gatilho comanda_item_setor (mig 0184).';

-- ── Gatilho: descobre o setor sozinho ────────────────────────────────────────
-- Fica no BANCO, não no app, porque item de comanda entra por vários caminhos
-- (tela do Salão, celular do garçom, app). No banco, todos passam por aqui.
CREATE OR REPLACE FUNCTION public.comanda_item_setor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_cat   text;
  v_setor text;
BEGIN
  -- Quem já mandou o setor na mão manda nele.
  IF NEW.setor IS NOT NULL AND NEW.setor <> 'salao' THEN RETURN NEW; END IF;
  NEW.setor := 'salao';
  IF NEW.produto_id IS NULL THEN RETURN NEW; END IF;

  -- produto_id é text e nem sempre é um uuid ("inventar produto" grava avulso).
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

DROP TRIGGER IF EXISTS trg_comanda_item_setor ON public.comanda_itens;
CREATE TRIGGER trg_comanda_item_setor
  BEFORE INSERT ON public.comanda_itens
  FOR EACH ROW EXECUTE FUNCTION public.comanda_item_setor();

NOTIFY pgrst, 'reload schema';
