-- Preenchimento fiscal automatico por NOME (0438) vale pra revenda de industrializado
-- com ST (caso da Agv). Loja que FABRICA o que vende (CDBom: sorvete proprio = CFOP 5101,
-- CSOSN 102) nao pode receber essa regra: o sorvete sairia 5405/500.
-- Chave por loja: fiscal_auto (padrao ligado, igual ao comportamento atual).
alter table empresa_fiscal add column if not exists fiscal_auto boolean not null default true;

create or replace function public.trg_fiscal_auto_produto()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE r fiscal_regras;
BEGIN
  IF NEW.cfop IS NOT NULL OR NEW.csosn IS NOT NULL OR NEW.cest IS NOT NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM empresa_fiscal WHERE empresa_id = NEW.empresa_id AND ativo AND fiscal_auto) THEN RETURN NEW; END IF;
  SELECT * INTO r FROM fiscal_classificar(NEW.nome, NEW.categoria);
  IF r.id IS NULL THEN RETURN NEW; END IF;
  NEW.cfop := r.cfop; NEW.csosn := r.csosn; NEW.cest := r.cest;
  IF NEW.ncm IS NULL OR length(regexp_replace(NEW.ncm, '\D', '', 'g')) <> 8 THEN NEW.ncm := r.ncm; END IF;
  IF NEW.origem IS NULL THEN NEW.origem := r.origem; END IF;
  RETURN NEW;
END $function$;

create or replace function public.fiscal_aplicar_regras(p_empresa uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE n int := 0; p record; r fiscal_regras;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM empresa_fiscal WHERE empresa_id = p_empresa AND fiscal_auto) THEN RETURN 0; END IF;
  FOR p IN SELECT id, nome, categoria, ncm, origem FROM produtos
            WHERE empresa_id = p_empresa AND cfop IS NULL AND csosn IS NULL AND cest IS NULL LOOP
    SELECT * INTO r FROM fiscal_classificar(p.nome, p.categoria);
    CONTINUE WHEN r.id IS NULL;
    UPDATE produtos SET cfop = r.cfop, csosn = r.csosn, cest = r.cest,
           ncm = CASE WHEN length(regexp_replace(coalesce(p.ncm,''), '\D', '', 'g')) = 8 THEN p.ncm ELSE r.ncm END,
           origem = coalesce(p.origem, r.origem)
     WHERE id = p.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

-- CDBom: automatico desligado; sorvete que ela fabrica = 5101 / 102 (tabela do contador, 06/11/2026).
update empresa_fiscal set fiscal_auto = false where empresa_id = 'a95b716b-d973-42ab-ace9-dae0fd1acd62';
update produtos set cfop = '5101', csosn = '102', ncm = '21050010', origem = '0'
 where empresa_id = 'a95b716b-d973-42ab-ace9-dae0fd1acd62'
   and categoria in ('Sorvetes', 'Cremes', 'Sundae')
   and cfop is null and csosn is null and cest is null;
