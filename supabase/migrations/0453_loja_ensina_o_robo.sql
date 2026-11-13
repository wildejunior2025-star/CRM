-- ─────────────────────────────────────────────────────────────────────────────
-- 0453 — A loja ensina o robô sozinha
--
-- 12/11/2026, Agv Grill. A cliente escreveu "Opções do dia" e o robô respondeu
-- "Essa eu não sei te responder por aqui 😅". Ela queria as quentinhas — o
-- cardápio responderia, mas "opções do dia" não está na lista de palavras que
-- puxa o cardápio, e essa lista mora no CÓDIGO.
--
-- Esse é o problema de verdade, e não é a palavra: cada loja fala do seu jeito
-- ("quentinha" aqui, "marmitex" ali, "o que tem hoje" em outra), e hoje toda
-- palavra nova precisa passar por um programador. A loja tem que conseguir
-- ensinar o robô sozinha, na hora que ele erra.
--
-- Duas tabelas:
--
--   whatsapp_ensinos  — "quando o cliente disser isto, responda aquilo".
--                       É da loja, ela escreve e apaga quando quiser.
--   whatsapp_duvidas  — o que o robô NÃO soube responder, guardado pra loja
--                       ver e ensinar a partir do erro real. Sem isto o dono
--                       só descobre o buraco quando o cliente reclama.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── O que a loja ensinou ─────────────────────────────────────────────────────
create table if not exists public.whatsapp_ensinos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  -- Separadas por vírgula, do jeito que a loja escreve: "opções do dia,
  -- quentinha, marmita". Acento e maiúscula não importam na hora de comparar.
  palavras text not null,
  -- Pode conter {link} — vira o link do cardápio já com o telefone do cliente.
  resposta text not null,
  ativo boolean not null default true,
  -- Pra loja ver o que está pegando e o que nunca foi usado.
  usos integer not null default 0,
  ultimo_uso timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_ensinos_empresa_idx
  on public.whatsapp_ensinos (empresa_id) where ativo;

alter table public.whatsapp_ensinos enable row level security;

create policy "Loja le o que ensinou" on public.whatsapp_ensinos
  for select to authenticated
  using (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin');

create policy "Loja ensina" on public.whatsapp_ensinos
  for insert to authenticated
  with check (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin');

create policy "Loja corrige o que ensinou" on public.whatsapp_ensinos
  for update to authenticated
  using (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin')
  with check (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin');

create policy "Loja apaga o que ensinou" on public.whatsapp_ensinos
  for delete to authenticated
  using (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin');

-- ── O que o robô não soube responder ─────────────────────────────────────────
create table if not exists public.whatsapp_duvidas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  pergunta text not null,
  -- Sem acento e em minúscula: é por aqui que a mesma pergunta repetida
  -- vira uma linha só com o contador subindo, em vez de encher a tela.
  pergunta_norm text not null,
  vezes integer not null default 1,
  ultimo_phone text,
  resolvida boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists whatsapp_duvidas_uma_por_pergunta
  on public.whatsapp_duvidas (empresa_id, pergunta_norm);

alter table public.whatsapp_duvidas enable row level security;

create policy "Loja le as duvidas" on public.whatsapp_duvidas
  for select to authenticated
  using (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin');

-- Marcar como resolvida / apagar da lista. Quem GRAVA é o robô (service_role),
-- por isso não tem policy de insert pra loja.
create policy "Loja resolve a duvida" on public.whatsapp_duvidas
  for update to authenticated
  using (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin')
  with check (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin');

create policy "Loja apaga a duvida" on public.whatsapp_duvidas
  for delete to authenticated
  using (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin');

-- ── O robô anota a pergunta que não soube ────────────────────────────────────
--
-- Pergunta repetida não vira linha nova: sobe o contador. É o contador que
-- diz pro dono o que ensinar primeiro — "20 pessoas perguntaram isso" é
-- diferente de "uma pessoa perguntou uma vez".
create or replace function public.registrar_duvida(
  p_empresa uuid, p_phone text, p_pergunta text
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_texto text := btrim(p_pergunta);
  v_norm  text;
begin
  if v_texto = '' or length(v_texto) > 300 then return; end if;
  -- unaccent não está instalado em todo projeto: translate dá conta do que
  -- aparece em português.
  v_norm := lower(translate(v_texto,
    'ÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇáàãâäéèêëíìîïóòõôöúùûüç',
    'AAAAAEEEEIIIIOOOOOUUUUCaaaaaeeeeiiiiooooouuuuc'));
  v_norm := btrim(regexp_replace(v_norm, '[^a-z0-9 ]', ' ', 'g'));
  v_norm := regexp_replace(v_norm, ' +', ' ', 'g');
  if v_norm = '' then return; end if;

  insert into whatsapp_duvidas (empresa_id, pergunta, pergunta_norm, ultimo_phone)
  values (p_empresa, v_texto, v_norm, p_phone)
  on conflict (empresa_id, pergunta_norm) do update
    set vezes = whatsapp_duvidas.vezes + 1,
        ultimo_phone = excluded.ultimo_phone,
        updated_at = now(),
        -- Voltou a ser perguntada depois de resolvida: volta pra lista.
        resolvida = false;
end;
$$;

revoke all on function public.registrar_duvida(uuid, text, text) from public;
revoke execute on function public.registrar_duvida(uuid, text, text) from anon, authenticated;
grant execute on function public.registrar_duvida(uuid, text, text) to service_role;

-- Contador de uso do ensino. Mesma razão: é fire-and-forget do robô.
create or replace function public.contar_uso_ensino(p_id uuid)
returns void
language sql security definer set search_path = public
as $$
  update whatsapp_ensinos set usos = usos + 1, ultimo_uso = now() where id = p_id;
$$;

revoke all on function public.contar_uso_ensino(uuid) from public;
revoke execute on function public.contar_uso_ensino(uuid) from anon, authenticated;
grant execute on function public.contar_uso_ensino(uuid) to service_role;
