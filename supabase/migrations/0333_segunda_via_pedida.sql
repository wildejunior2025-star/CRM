-- 0333: segunda via da conta pedida de um aparelho SEM impressora.
--
-- Igual à pré-conta (mig 0186): o celular que não tem a térmica Bluetooth carimba
-- a comanda e a estação da loja (o celular/PC que está com a impressora) tira o
-- papel ao ver o carimbo novo pelo tempo real. Fica gravado e carimbo anterior à
-- abertura da tela é ignorado.
ALTER TABLE public.comandas
  ADD COLUMN IF NOT EXISTS segunda_via_pedida_em timestamptz;

COMMENT ON COLUMN public.comandas.segunda_via_pedida_em IS
  'Quando alguém pediu a segunda via da conta de um aparelho sem impressora. A estação imprime ao ver o carimbo novo (mig 0333).';

NOTIFY pgrst, 'reload schema';
