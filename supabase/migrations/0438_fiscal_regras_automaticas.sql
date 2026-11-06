-- 0438 — Classificação fiscal AUTOMÁTICA dos produtos (NFC-e)
--
-- O dono da loja não sabe CFOP/CSOSN/NCM/CEST e não deve precisar saber: ele
-- só aperta o botão e gera a nota (Wilde, 06/11/2026). Aqui o sistema preenche
-- sozinho o que ficou em branco no produto, pelo NOME/CATEGORIA, usando os
-- valores que o contador da Agv já provou em produção (27/10/2026):
--   refrigerante  22021000  5405/500  CEST 0301100
--   água mineral  22011000  5405/500  CEST 0300504
--   energético    22029900  5405/500  CEST 0301300
--   picolé/sorvete 21050010 5405/500  CEST 2300100
-- Tudo o que NÃO casar com uma regra fica em branco e a nota usa o padrão da
-- loja (5102/102) — melhor que chutar errado. Cerveja e outras bebidas
-- alcoólicas ficam de fora até o contador confirmar o CEST.
--
-- Nunca sobrescreve: só preenche produto com cfop, csosn e cest vazios, e só em
-- loja com a nota fiscal ATIVA (empresa_fiscal.ativo). Quando uma loja ativar a
-- nota, rodar: SELECT fiscal_aplicar_regras('<empresa_id>');

CREATE TABLE IF NOT EXISTS fiscal_regras (
  id         serial PRIMARY KEY,
  ordem      int  NOT NULL,
  grupo      text NOT NULL,
  rx         text NOT NULL,          -- casa no nome+categoria, sem acento, minúsculo (\y = limite de palavra)
  excluir_rx text,                   -- se casar aqui, a regra não vale
  ncm        text NOT NULL,
  cfop       text NOT NULL,
  csosn      text NOT NULL,
  cest       text,
  origem     text NOT NULL DEFAULT '0'
);
ALTER TABLE fiscal_regras ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fiscal_regras_leitura ON fiscal_regras;
CREATE POLICY fiscal_regras_leitura ON fiscal_regras FOR SELECT TO authenticated USING (true);

TRUNCATE fiscal_regras;
INSERT INTO fiscal_regras (ordem, grupo, rx, excluir_rx, ncm, cfop, csosn, cest) VALUES
 (1, 'sorvete',    '\y(picole|skimo|kibon|magnum|cornetto|sorvete)\y', NULL,                    '21050010', '5405', '500', '2300100'),
 (2, 'agua',       '\yagua (mineral|com gas|sem gas)\y',               NULL,                    '22011000', '5405', '500', '0300504'),
 (3, 'energetico', '\y(red ?bull|monster|baly|tnt|energetico)\y',      'picole|sorvete',        '22029900', '5405', '500', '0301300'),
 (4, 'refrigerante','\y(coca|guarana|fanta|sprite|pepsi|sukita|schweppes|dolly|refrigerante)\y', 'xarope|sabor|picole|sorvete', '22021000', '5405', '500', '0301100');

CREATE OR REPLACE FUNCTION fiscal_classificar(p_nome text, p_categoria text)
RETURNS fiscal_regras LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  WITH t AS (
    SELECT translate(lower(coalesce(p_nome,'') || ' ' || coalesce(p_categoria,'')),
                     'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') AS txt
  )
  SELECT r.* FROM fiscal_regras r, t
   WHERE t.txt ~ r.rx AND (r.excluir_rx IS NULL OR t.txt !~ r.excluir_rx)
   ORDER BY r.ordem LIMIT 1
$$;

-- Preenche UM produto (usado pelo gatilho e pela varredura).
CREATE OR REPLACE FUNCTION trg_fiscal_auto_produto()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r fiscal_regras;
BEGIN
  IF NEW.cfop IS NOT NULL OR NEW.csosn IS NOT NULL OR NEW.cest IS NOT NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM empresa_fiscal WHERE empresa_id = NEW.empresa_id AND ativo) THEN RETURN NEW; END IF;
  SELECT * INTO r FROM fiscal_classificar(NEW.nome, NEW.categoria);
  IF r.id IS NULL THEN RETURN NEW; END IF;
  NEW.cfop := r.cfop; NEW.csosn := r.csosn; NEW.cest := r.cest;
  IF NEW.ncm IS NULL OR length(regexp_replace(NEW.ncm, '\D', '', 'g')) <> 8 THEN NEW.ncm := r.ncm; END IF;
  IF NEW.origem IS NULL THEN NEW.origem := r.origem; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_fiscal_auto ON produtos;
CREATE TRIGGER trg_fiscal_auto
  BEFORE INSERT OR UPDATE OF nome, categoria ON produtos
  FOR EACH ROW EXECUTE FUNCTION trg_fiscal_auto_produto();

-- Varredura de uma loja (rodar quando ela ativar a nota fiscal). Devolve quantos preencheu.
CREATE OR REPLACE FUNCTION fiscal_aplicar_regras(p_empresa uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n int := 0; p record; r fiscal_regras;
BEGIN
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
END $$;

-- Agv Grill (única loja com a nota ativa hoje)
SELECT fiscal_aplicar_regras('febc3db3-1b04-4cdc-a22f-119db381fbeb');
