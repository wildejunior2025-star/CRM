-- 0364 — TIPOS DE ENTRADA E SAÍDA PELO WHATSAPP
-- Entrada: compra, devolucao, bonificacao, ajuste_inventario. Saída: perda, vencimento, consumo, brinde,
-- ajuste_inventario (venda é automática). Perda e vencimento viram imprevisto no financeiro (igual ao "Produto
-- perdido" do Portal); estoque_whatsapp.imprevistos guarda os ids pra o DESFAZER apagar junto.
alter table estoque_whatsapp add column if not exists imprevistos jsonb;

-- Lojas que já personalizaram a lista de motivos ganham os novos; as demais usam o padrão do Portal (MOTIVOS_PADRAO).
insert into motivos_estoque (empresa_id, tipo, nome)
select distinct m.empresa_id, v.tipo, v.nome
  from motivos_estoque m
 cross join (values ('entrada','bonificacao'), ('saida','vencimento'), ('saida','consumo'), ('saida','brinde')) as v(tipo, nome)
 where not exists (select 1 from motivos_estoque x where x.empresa_id = m.empresa_id and x.tipo = v.tipo and x.nome = v.nome);
