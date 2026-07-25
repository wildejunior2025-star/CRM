-- No atendimento presencial, não exigir os complementos obrigatórios.
--
-- Por quê: na mesa e no balcão o atendente monta o prato junto com o cliente e
-- a cozinha vê o pedido na hora. Obrigar a clicar em 9 grupos (arroz, feijão,
-- macarrão, salada, proteína...) só pra lançar uma quentinha é perda de tempo —
-- e quentinha nem controla estoque por ingrediente.
--
-- Onde vale: Salão (garçom/balcão) e Cardápio da mesa por QR.
-- Onde NÃO vale: Loja Online e Nova venda do gestor — ali o pedido chega sem
-- ninguém por perto pra perguntar, então o obrigatório continua valendo.
--
-- Desligado por padrão: nenhuma loja muda de comportamento sem ligar o botão.

alter table public.empresas
  add column if not exists presencial_sem_obrigatorios boolean not null default false;

comment on column public.empresas.presencial_sem_obrigatorios is
  'true = no Salao e no cardapio da mesa (QR), complemento obrigatorio (min>0) vira opcional. Nao afeta Loja Online nem Nova venda.';

-- O cardápio do QR é anônimo e lê tudo por esta função — precisa do campo novo.
create or replace function public.mesa_info(p_token text)
returns json
language sql
stable security definer
set search_path to 'public'
as $function$
  SELECT json_build_object(
    'mesa_id', m.id, 'numero', m.numero, 'nome', m.nome, 'ativa', m.ativa,
    'empresa_id', e.id, 'empresa_nome', e.nome, 'logo_url', e.logo_url,
    'presencial_ativo', e.presencial_ativo,
    'sem_obrigatorios', e.presencial_sem_obrigatorios
  )
  FROM mesas m JOIN empresas e ON e.id = m.empresa_id
  WHERE m.token = p_token;
$function$;
