-- 0361 — correção DEPOIS de lançar: a lista nova guarda qual lançamento substitui (o SIM desfaz o velho e lança o novo)
alter table estoque_whatsapp add column if not exists substitui_id uuid references estoque_whatsapp(id) on delete set null;
