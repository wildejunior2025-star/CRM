-- ─────────────────────────────────────────────────────────────────────────────
-- 0390 — O robô lembra da correção da loja
--
-- A IA classifica o item da nota pelo nome ("DET ABSOLUTO 400G" → Limpeza), e
-- em item ambíguo ela erra: papel toalha é Limpeza ou Descartáveis? Depende da
-- loja. Até aqui o dono corrigia na mão e, na nota seguinte, errava igual.
--
-- Agora cada correção vira uma linha aqui, POR LOJA. Na próxima nota o termo
-- entra no pedido da IA ("a loja já disse que isto é X") e, depois da resposta,
-- é aplicado de novo no código — prompt convence, código garante.
--
-- `termo` é a CHAVE CURTA da descrição: as duas primeiras palavras, sem acento
-- e sem pontuação ("DET ABSOLUTO 400G" → "det absoluto"). O fornecedor imprime
-- a mesma abreviação toda semana, mudando só o tamanho/gramatura — casar pela
-- descrição inteira perderia "DET ABSOLUTO 500G" na compra seguinte.
-- `exemplo` guarda a linha inteira como veio, pra tela mostrar de onde saiu.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists categoria_item_aprendida (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references empresas(id) on delete cascade,
  termo       text not null,
  categoria   text not null,
  exemplo     text,
  vezes       integer not null default 1,
  criado_em   timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (empresa_id, termo)
);

create index if not exists idx_cat_aprendida_empresa on categoria_item_aprendida (empresa_id);

alter table categoria_item_aprendida enable row level security;

-- Mesma regra do resto do financeiro: quem é da loja enxerga e mexe no que é
-- da loja. O robô entra pela service_role, que não passa por RLS.
drop policy if exists cat_aprendida_ler on categoria_item_aprendida;
create policy cat_aprendida_ler on categoria_item_aprendida
  for select using (empresa_id = current_empresa_id());

drop policy if exists cat_aprendida_escrever on categoria_item_aprendida;
create policy cat_aprendida_escrever on categoria_item_aprendida
  for all using (empresa_id = current_empresa_id())
  with check (empresa_id = current_empresa_id());

comment on table categoria_item_aprendida is
  'Correções de categoria que a loja fez num item de nota. O robô consulta antes de classificar a próxima.';
