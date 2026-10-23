-- Aviso no WhatsApp quando alguem da ENTRADA no estoque (23/10/2026)
--
-- POR QUE EXISTE
-- Pedido do Wilde: "tem dono que quem da entrada e o funcionario, mas se o
-- funcionario bota um a menos ele tem que ficar conferindo". Hoje a entrada ja
-- fica registrada (quem e quando, migs 0350/ficha tecnica), mas so olhando o
-- historico — e dono de loja pequena nao abre historico, ele esta na rua.
-- Com o aviso no zap ele ve na hora, onde estiver, e compara com a nota do
-- fornecedor sem voltar na loja.
--
-- POR QUE AGRUPADO, E NAO UMA MENSAGEM POR ITEM
-- Entrada de mercadoria vem em lote: chega o fornecedor e a pessoa lanca 10
-- itens seguidos. Uma mensagem por item seria spam e o dono desligaria o aviso
-- na primeira semana — ou pior, pararia de ler. Entao o gatilho so MARCA, e um
-- cron de 2 em 2 minutos junta tudo que a mesma pessoa lancou e manda UMA
-- mensagem com a lista. Dois minutos de atraso nao custam nada pra quem quer
-- conferir nota de fornecedor.
--
-- POR QUE NAO TEM FILA PROPRIA
-- A coluna `avisado_em` na propria tabela de movimento ja e a fila: pendente e
-- o que esta NULL. Uma tabela a mais so daria outro lugar pra dessincronizar.

-- ── liga/desliga por loja ───────────────────────────────────────────────────
-- Separado do `notif_estoque` (aquele e estoque BAIXO, outro assunto). O
-- numero que recebe e o mesmo `admin_phone` que a tela ja chama de "Numero do
-- responsavel (alertas e reclamacoes)".
alter table public.whatsapp_config
  add column if not exists notif_entrada_estoque boolean not null default false;

comment on column public.whatsapp_config.notif_entrada_estoque is
  'Avisa o admin_phone no WhatsApp a cada entrada de estoque, com quem lancou e o saldo que ficou.';

-- ── a fila ──────────────────────────────────────────────────────────────────
alter table public.estoque_movimentos
  add column if not exists avisado_em timestamptz;
alter table public.materia_prima_movimentos
  add column if not exists avisado_em timestamptz;

-- Indice so do que importa: as entradas ainda nao avisadas. Parcial pra nao
-- carregar as 3.500 saidas que nunca entram nesta conta.
create index if not exists estoque_mov_entrada_a_avisar
  on public.estoque_movimentos (empresa_id, created_at)
  where tipo = 'entrada' and avisado_em is null;
create index if not exists mp_mov_entrada_a_avisar
  on public.materia_prima_movimentos (empresa_id, created_at)
  where tipo = 'entrada' and avisado_em is null;

-- O que ja existe nasceu antes do aviso: marca como avisado pra nao disparar
-- uma enxurrada retroativa na primeira rodada do cron.
update public.estoque_movimentos        set avisado_em = now() where tipo = 'entrada' and avisado_em is null;
update public.materia_prima_movimentos  set avisado_em = now() where tipo = 'entrada' and avisado_em is null;

-- ── numero do jeito que o brasileiro le ───────────────────────────
-- O FM do to_char tira os zeros a direita mas DEIXA o ponto: 24 virava "24.".
-- Saiu assim no primeiro ensaio ("entrou 24., ficou 24.").
create or replace function public.num_br(v numeric)
returns text
language sql
immutable
as $$
  select replace(trim(trailing '.' from to_char(v, 'FM999999990.999')), '.', ',')
$$;

-- ── quem lancou ─────────────────────────────────────────────────────────────
-- `created_by` ja vem de auth.uid() por padrao (mig 0350). Quando for nulo
-- (lancamento por rotina, importacao), a mensagem diz "sistema" em vez de
-- mentir um nome.
create or replace function public.estoque_quem_lancou(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(trim(p.nome), ''),
    nullif(trim(p.email), ''),
    'sistema'
  ) || case
         when p.perfil is null then ''
         when p.perfil = 'admin' then ' (administrador)'
         else ' (' || p.perfil || ')'
       end
    from profiles p where p.id = p_uid
$$;

-- ── a mensagem ──────────────────────────────────────────────────────────────
-- Devolve uma linha por (loja, pessoa) com o texto pronto, e MARCA como
-- avisado. A edge function so entrega — toda a regra fica aqui, perto dos
-- dados, pra nao existirem duas versoes da verdade.
create or replace function public.estoque_entrada_avisos()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saida jsonb := '[]'::jsonb;
begin
  with pendentes as (
    -- produtos do catalogo
    select m.id, m.empresa_id, m.created_by, m.created_at,
           'produto'::text as fonte,
           p.nome as item,
           m.quantidade,
           ''::text as unidade,
           (select coalesce(sum(case x.tipo when 'entrada' then x.quantidade
                                            when 'saida'   then -x.quantidade
                                            when 'ajuste'  then x.quantidade
                                            else 0 end), 0)
              from estoque_movimentos x where x.produto_id = m.produto_id) as saldo
      from estoque_movimentos m
      join produtos p on p.id = m.produto_id
     where m.tipo = 'entrada' and m.avisado_em is null
       and m.created_at > now() - interval '2 days'
    union all
    -- materia-prima da ficha tecnica
    select m.id, m.empresa_id, m.created_by, m.created_at,
           'insumo'::text,
           mp.nome,
           m.quantidade,
           coalesce(mp.unidade, ''),
           (select coalesce(sum(case x.tipo when 'entrada' then x.quantidade
                                            when 'saida'   then -x.quantidade
                                            when 'ajuste'  then x.quantidade
                                            else 0 end), 0)
              from materia_prima_movimentos x where x.materia_prima_id = m.materia_prima_id)
      from materia_prima_movimentos m
      join materias_primas mp on mp.id = m.materia_prima_id
     where m.tipo = 'entrada' and m.avisado_em is null
       and m.created_at > now() - interval '2 days'
  ),
  -- So loja com o aviso ligado, com numero e com WhatsApp conectado.
  validas as (
    select pe.*, wc.admin_phone, e.nome as loja,
           -- Loja sem zap proprio conectado cai no numero da FWC, que o dono
           -- ja tem salvo como suporte. Quando ela conectar, volta a sair
           -- pelo numero dela sozinho, sem mexer em nada aqui.
           coalesce(nullif(trim(wc.instance_name), ''),
                    (select valor from config_global where chave = 'admin_sender_instance'),
                    'crmadmin') as instance_name
      from pendentes pe
      join whatsapp_config wc on wc.empresa_id = pe.empresa_id
      join empresas e on e.id = pe.empresa_id
     where wc.notif_entrada_estoque
       and coalesce(trim(wc.admin_phone), '') <> ''
  ),
  -- Uma mensagem por pessoa: o lote inteiro que ela acabou de lancar.
  agrupado as (
    select v.empresa_id, v.created_by, v.admin_phone, v.instance_name, v.loja,
           max(v.created_at) as quando,
           string_agg(
             '• ' || v.item || ' — entrou ' ||
             num_br(v.quantidade) ||
             case when v.unidade <> '' then ' ' || v.unidade else '' end ||
             ', ficou ' || num_br(v.saldo),
             chr(10) order by v.item
           ) as lista,
           array_agg(v.id) filter (where v.fonte = 'produto') as ids_produto,
           array_agg(v.id) filter (where v.fonte = 'insumo')  as ids_insumo
      from validas v
     group by v.empresa_id, v.created_by, v.admin_phone, v.instance_name, v.loja
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'empresa_id', g.empresa_id,
           'instancia',  g.instance_name,
           'telefone',   g.admin_phone,
           'texto',
             '📦 *Entrada no estoque*' || chr(10) || chr(10) ||
             'Quem lançou: *' || estoque_quem_lancou(g.created_by) || '*' || chr(10) ||
             'Quando: ' || to_char(g.quando at time zone 'America/Fortaleza', 'DD/MM às HH24:MI') ||
             chr(10) || chr(10) || g.lista
         )), '[]'::jsonb)
    into v_saida
    from agrupado g;

  -- Marca só o que entrou em alguma mensagem. O que ficou de fora (loja com o
  -- aviso desligado) continua NULL de propósito: se ela ligar o aviso depois,
  -- o certo é não despejar o passado — por isso o cron só olha 2 dias pra trás.
  update estoque_movimentos m set avisado_em = now()
   where m.tipo = 'entrada' and m.avisado_em is null
     and m.created_at > now() - interval '2 days'
     and exists (select 1 from whatsapp_config wc
                  where wc.empresa_id = m.empresa_id and wc.notif_entrada_estoque
                    and coalesce(trim(wc.admin_phone), '') <> '');

  update materia_prima_movimentos m set avisado_em = now()
   where m.tipo = 'entrada' and m.avisado_em is null
     and m.created_at > now() - interval '2 days'
     and exists (select 1 from whatsapp_config wc
                  where wc.empresa_id = m.empresa_id and wc.notif_entrada_estoque
                    and coalesce(trim(wc.admin_phone), '') <> '');

  return v_saida;
end;
$$;

-- Mesma conta, sem mandar e sem marcar: serve pra conferir o texto antes de
-- soltar numa loja de verdade (?seco=1 na edge function). Repete o corpo de
-- proposito — uma funcao que marca linhas nao pode ser usada pra espiar.
create or replace function public.estoque_entrada_avisos_previa()
returns jsonb
language sql
stable
security definer
set search_path = public
as $previa$
  with pendentes as (
    select m.id, m.empresa_id, m.created_by, m.created_at,
           'produto'::text as fonte, p.nome as item, m.quantidade, ''::text as unidade,
           (select coalesce(sum(case x.tipo when 'entrada' then x.quantidade
                                            when 'saida'   then -x.quantidade
                                            when 'ajuste'  then x.quantidade
                                            else 0 end), 0)
              from estoque_movimentos x where x.produto_id = m.produto_id) as saldo
      from estoque_movimentos m
      join produtos p on p.id = m.produto_id
     where m.tipo = 'entrada' and m.avisado_em is null
       and m.created_at > now() - interval '2 days'
    union all
    select m.id, m.empresa_id, m.created_by, m.created_at,
           'insumo'::text, mp.nome, m.quantidade, coalesce(mp.unidade, ''),
           (select coalesce(sum(case x.tipo when 'entrada' then x.quantidade
                                            when 'saida'   then -x.quantidade
                                            when 'ajuste'  then x.quantidade
                                            else 0 end), 0)
              from materia_prima_movimentos x where x.materia_prima_id = m.materia_prima_id)
      from materia_prima_movimentos m
      join materias_primas mp on mp.id = m.materia_prima_id
     where m.tipo = 'entrada' and m.avisado_em is null
       and m.created_at > now() - interval '2 days'
  ),
  validas as (
    select pe.*, wc.admin_phone, e.nome as loja,
           -- Loja sem zap proprio conectado cai no numero da FWC, que o dono
           -- ja tem salvo como suporte. Quando ela conectar, volta a sair
           -- pelo numero dela sozinho, sem mexer em nada aqui.
           coalesce(nullif(trim(wc.instance_name), ''),
                    (select valor from config_global where chave = 'admin_sender_instance'),
                    'crmadmin') as instance_name
      from pendentes pe
      join whatsapp_config wc on wc.empresa_id = pe.empresa_id
      join empresas e on e.id = pe.empresa_id
     where wc.notif_entrada_estoque
       and coalesce(trim(wc.admin_phone), '') <> ''
  ),
  agrupado as (
    select v.empresa_id, v.created_by, v.admin_phone, v.instance_name, v.loja,
           max(v.created_at) as quando,
           string_agg('• ' || v.item || ' — entrou ' || num_br(v.quantidade) ||
             case when v.unidade <> '' then ' ' || v.unidade else '' end ||
             ', ficou ' || num_br(v.saldo), chr(10) order by v.item) as lista
      from validas v
     group by v.empresa_id, v.created_by, v.admin_phone, v.instance_name, v.loja
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'loja', g.loja, 'empresa_id', g.empresa_id,
           'instancia', g.instance_name, 'telefone', g.admin_phone,
           'texto',
             '📦 *Entrada no estoque*' || chr(10) || chr(10) ||
             'Quem lançou: *' || estoque_quem_lancou(g.created_by) || '*' || chr(10) ||
             'Quando: ' || to_char(g.quando at time zone 'America/Fortaleza', 'DD/MM às HH24:MI') ||
             chr(10) || chr(10) || g.lista
         )), '[]'::jsonb)
    from agrupado g
$previa$;

revoke all on function public.estoque_entrada_avisos()  from public, anon, authenticated;
revoke all on function public.estoque_entrada_avisos_previa() from public, anon, authenticated;
revoke all on function public.estoque_quem_lancou(uuid) from public, anon, authenticated;

-- ── o gatilho ───────────────────────────────────────────────────────────────
-- 2 em 2 minutos: tempo de a pessoa terminar de lançar o lote do fornecedor e
-- a mensagem sair inteira, sem o dono sentir atraso.
select cron.unschedule('estoque-entrada-aviso')
 where exists (select 1 from cron.job where jobname = 'estoque-entrada-aviso');

select cron.schedule(
  'estoque-entrada-aviso',
  '*/2 * * * *',
  $cron$
  select net.http_post(
    url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/estoque-entrada-aviso',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )
  $cron$
);
