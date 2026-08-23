-- 0186_preconta_pedida.sql
-- O garçom pede a pré-conta do celular DELE, que não tem impressora.
--
-- Quem imprime é a estação (o celular do balcão com a térmica, ou o PC com o
-- app FWC). Faltava um recado entre os dois: a pré-conta não gravava nada, era
-- só uma ação local — então no aparelho do garçom não saía nada e ele achava
-- que a impressora tinha falhado.
--
-- O carimbo fica na comanda: o garçom carimba, a estação vê o carimbo novo pelo
-- tempo real e tira o papel. Fica GRAVADO (não é recado que se perde no ar) e
-- carimbo velho é ignorado por ser anterior à abertura da tela.

ALTER TABLE public.comandas
  ADD COLUMN IF NOT EXISTS preconta_pedida_em timestamptz;

COMMENT ON COLUMN public.comandas.preconta_pedida_em IS
  'Quando o garçom pediu a pré-conta de um aparelho sem impressora. A estação imprime ao ver o carimbo novo (mig 0186).';

NOTIFY pgrst, 'reload schema';
