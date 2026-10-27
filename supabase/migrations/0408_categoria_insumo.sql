-- 0408 — CATEGORIA NA MATÉRIA-PRIMA (estoque de insumos organizado: carnes, hortifruti, limpeza…)
--
-- 27/10/2026: o dono do AGV quer o estoque de insumos separado por categoria, sempre com o valor
-- total à vista. As categorias são as MESMAS da compra (src/lib/categoriasFinanceiro.js), pra o que
-- ele compra e o que ele guarda falarem a mesma língua.
--
-- Palpite pelo nome: a função abaixo espelha palpiteCategoriaInsumo() do front. Vale pra insumo novo
-- (gatilho, qualquer porta de entrada: tela, robô, IA da nota) e pro que já existe (preenchido uma vez).
-- O dono corrige no cadastro; o que ele escolher nunca é sobrescrito (gatilho só age com categoria vazia).

alter table materias_primas add column if not exists categoria text;

create or replace function categoria_insumo_palpite(p_nome text) returns text
language sql immutable as $$
  with n as (
    select ' ' || regexp_replace(lower(translate(coalesce(p_nome, ''),
      'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')), '[^a-z0-9]+', ' ', 'g') || ' ' as t
  )
  select case
    when t ~ ' (sanitaria|detergente|esponja|bombril|sabao|vassoura|desinfetante|sabonete|alcool|cloro|multiuso|rodo|flanela|limpa|inseticida|amaciante) ' then 'Limpeza e higiene'
    when t ~ ' (descartavel|descartaveis|marmitex|sacola|sacolas|guardanapo|embalagem|embalagens|canudo|canudos|copo|copos|pote|potes|luva|luvas|touca|isopor|aluminio|filme|toalha|marmita) ' then 'Descartáveis e embalagens'
    when t ~ ' (gas|botijao) ' then 'Gás'
    when t ~ ' (agua|cerveja|budweiser|long neck|refrigerante|coca|guarana|suco|energetico|red bull|vinho|whisky|vodka|cachaca|h2o|pepsi|fanta|sprite|heineken|skol|brahma|antarctica) ' then 'Bebidas'
    when t ~ ' (pao|paes|brioche|bolo|torrada|bisnaguinha) ' then 'Padaria e confeitaria'
    when t ~ ' (arroz|feijao|acucar|sal|oleo|azeite|farinha|macarrao|espaguete|massa|molho|molhos|tempero|temperos|cafe|vinagre|maionese|ketchup|catchup|mostarda|amido|biscoito|goma|colorau|cominho|noz moscada|paprica|pimenta|adocante|bicarbonato|coco|doce|chocolate|azulim|palha|milho|shoyu|fermento|polvilho|tapioca|cha|lentilha|grao|ervilha|aveia|cereal|granola|gelatina|pudim|extrato|caldo|sazon|condensado|po) ' then 'Mercearia'
    when t ~ ' (congelado|congelada|congelados|congeladas|sorvete|polpa|nuggets|empanado) ' then 'Congelados'
    when t ~ ' (leite|queijo|manteiga|margarina|requeijao|iogurte|ovo|ovos|nata|mussarela|coalho) ' then 'Laticínios e ovos'
    when t ~ ' (carne|bovina|bovino|frango|coxa|peito|file|costela|linguica|bacon|hamburguer|presunto|mortadela|fiambre|figado|musculo|suino|suina|rabo|charque|jerked|calabresa|lingua|galinha|camarao|peixe|tilapia|bife|picanha|acem|patinho|salsicha|feijoada|carre|pernil|toucinho|peru|copa|bucho|coxao|alcatra|fraldinha|maminha|contra|sobrecoxa|tambaqui|bacalhau) ' then 'Carnes e frios'
    when t ~ ' (abacaxi|abobrinha|alface|alho|batata|batatas|beterraba|cebola|cebolinha|cenoura|cheiro verde|coentro|couve|jerimum|laranja|limao|macaxeira|mamao|manga|maxixe|melancia|melao|pepino|pimentao|quiabo|repolho|tomate|tomates|fava|banana|maca|uva|abacate|salsa|hortela|gengibre|inhame|rucula|acelga|chuchu|vagem|brocolis|couve flor|morango|maracuja|goiaba|acerola|caju|cajus) ' then 'Hortifruti'
    when t ~ ' (faca|facas|panela|panelas|tabua|utensilio|espatula|pegador|assadeira|frigideira|colher|garfo|prato|pratos) ' then 'Equipamentos e utensílios'
    else null
  end from n
$$;

create or replace function trg_materia_categoria() returns trigger
language plpgsql as $$
begin
  if new.categoria is null or btrim(new.categoria) = '' then
    new.categoria := categoria_insumo_palpite(new.nome);
  end if;
  return new;
end $$;

drop trigger if exists materias_primas_categoria on materias_primas;
create trigger materias_primas_categoria before insert on materias_primas
  for each row execute function trg_materia_categoria();

-- uma vez só: classifica o que já existe
update materias_primas set categoria = categoria_insumo_palpite(nome) where categoria is null;

-- a view de saldo passa a trazer a categoria (coluna nova SEMPRE no fim, senão o REPLACE falha)
create or replace view materia_prima_saldo as
 select mp.id as materia_prima_id, mp.nome, mp.unidade, mp.custo,
        coalesce(sum(case when mv.tipo = 'entrada' then mv.quantidade
                          when mv.tipo = 'saida' then - mv.quantidade
                          when mv.tipo = 'ajuste' then mv.quantidade else 0 end), 0) as quantidade_atual,
        mp.estoque_minimo,
        mp.categoria
   from materias_primas mp
   left join materia_prima_movimentos mv on mv.materia_prima_id = mp.id
  where mp.empresa_id = current_empresa_id()
  group by mp.id, mp.nome, mp.unidade, mp.custo, mp.estoque_minimo, mp.categoria;
