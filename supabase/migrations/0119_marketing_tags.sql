-- Tags de anúncio por loja (Google Ads + Meta/Facebook Pixel).
--
-- Cada loja anuncia na conta DELA. A Loja Online lê estes campos e carrega
-- as tags só daquela loja, então o dado de uma loja nunca cai na conta de outra.
-- Campo vazio = rastreamento desligado (nenhum script de terceiro é carregado).
--
-- Estes IDs são públicos por natureza (aparecem no código-fonte da página em
-- qualquer site que anuncia), por isso ficam em `empresas` e podem ser lidos
-- pelo visitante anônimo junto com o resto da vitrine.

alter table public.empresas
  add column if not exists google_ads_id      text,  -- ex: AW-123456789
  add column if not exists google_ads_label   text,  -- ex: AbC-D_efG12345 (rótulo da conversão)
  add column if not exists meta_pixel_id      text;  -- ex: 1234567890123456

comment on column public.empresas.google_ads_id    is 'ID de conversão do Google Ads da loja (AW-...). Vazio = desligado.';
comment on column public.empresas.google_ads_label is 'Rótulo da conversão "Compra" do Google Ads da loja.';
comment on column public.empresas.meta_pixel_id    is 'ID do Pixel da Meta (Facebook/Instagram) da loja. Vazio = desligado.';
