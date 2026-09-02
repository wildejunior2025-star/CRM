-- =========================================================
-- 0220: taxa de entrega de quem parou no cadastro
-- =========================================================
-- O funil já mostra o valor da sacola de quem chegou no endereço e desistiu.
-- Só que a sacola sozinha não responde a pergunta que o lojista faz: "ele
-- desistiu por causa do frete?". Uma sacola de R$ 14 com R$ 10 de taxa é uma
-- história bem diferente de uma sacola de R$ 14 com taxa de R$ 3.
--
-- A taxa não cabe em loja_funil: aquela tabela é uma linha por etapa, gravada
-- na hora que a pessoa CHEGA na tela — e a taxa só existe depois que ela digita
-- o endereço. Aqui, em loja_funil_contato, a linha já é atualizada conforme ele
-- preenche (nome, telefone, CEP), que é exatamente o momento da taxa.
--
-- NULL = não deu pra saber (saiu antes de informar o endereço, ou a loja não
-- conseguiu calcular). 0 = sem taxa (retirada ou entrega grátis).
-- =========================================================

ALTER TABLE public.loja_funil_contato
  ADD COLUMN IF NOT EXISTS taxa numeric(10,2);

COMMENT ON COLUMN public.loja_funil_contato.taxa IS
  'Taxa de entrega que estava sendo cobrada quando a pessoa parou. NULL = desconhecida, 0 = sem taxa (retirada/gratis).';

-- A versão de 5 argumentos sai de cena: com as duas no banco, o PostgREST não
-- consegue escolher qual chamar quando vêm 5 chaves (as duas servem) e devolve
-- "could not choose the best candidate function". Navegador com a tela antiga
-- em cache continua funcionando — cai nesta mesma, com p_taxa no default.
DROP FUNCTION IF EXISTS public.funil_contato(uuid, text, text, text, text);

CREATE OR REPLACE FUNCTION public.funil_contato(
  p_empresa  uuid,
  p_sessao   text,
  p_nome     text DEFAULT NULL,
  p_telefone text DEFAULT NULL,
  p_cep      text DEFAULT NULL,
  p_taxa     numeric DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Sessão é um uuid gerado no navegador. Barra lixo antes de escrever.
  IF p_sessao IS NULL OR length(p_sessao) NOT BETWEEN 8 AND 64 THEN RETURN; END IF;

  INSERT INTO public.loja_funil_contato (sessao, empresa_id, nome, telefone, cep, taxa)
  VALUES (
    p_sessao, p_empresa,
    nullif(btrim(left(p_nome, 120)), ''),
    nullif(btrim(left(p_telefone, 20)), ''),
    nullif(btrim(left(p_cep, 12)), ''),
    -- Taxa de entrega não passa de R$ 999: valor absurdo é bug de cálculo, e
    -- relatório com número absurdo faz o lojista desconfiar do resto.
    CASE WHEN p_taxa >= 0 AND p_taxa <= 999 THEN round(p_taxa, 2) ELSE NULL END
  )
  ON CONFLICT (sessao) DO UPDATE SET
    nome          = coalesce(excluded.nome,     public.loja_funil_contato.nome),
    telefone      = coalesce(excluded.telefone, public.loja_funil_contato.telefone),
    cep           = coalesce(excluded.cep,      public.loja_funil_contato.cep),
    -- A taxa acompanha o endereço: trocou de bairro, o valor novo manda.
    taxa          = coalesce(excluded.taxa,     public.loja_funil_contato.taxa),
    atualizado_em = now();
END $$;

GRANT EXECUTE ON FUNCTION public.funil_contato(uuid, text, text, text, text, numeric) TO anon, authenticated;
