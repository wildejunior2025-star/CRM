-- Wilde, 28/10/2026: "pode deixar todas as lojas ativadas, todos querem isso".
-- Taxa por km pelo caminho da moto em todas as lojas; loja nova tambem nasce assim.
-- As faixas ficam como estao (pela rua a media sobe 9% a 19%, medido em 47 entregas).
update public.empresas set taxa_pela_rua = true where taxa_pela_rua = false;
alter table public.empresas alter column taxa_pela_rua set default true;
