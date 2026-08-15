-- 0162_chave_endereco_sem_bairro.sql
-- Tira o BAIRRO da chave que decide se o pino salvo ainda vale.
--
-- O bairro é o campo que o cliente escreve diferente a cada pedido — o mesmo
-- Flávio, mesma casa, já mandou "Potengi" e "Panatis _1"; e tem "Nossa Senhora
-- da Apresentação", "Nossa Sra. da Apresentação", "Nossa  senhora da
-- apresentação" e "Ns Apresentacao" espalhados na base. Com o bairro na chave,
-- bastava ele digitar de um jeito novo pro pino certo ser descartado e a taxa
-- voltar a sair do buscador de mapa — que é justamente o que a 0160 veio matar.
--
-- Rua + número + cidade identifica a casa de sobra AQUI, porque a chave só é
-- usada pra decidir se o pino DAQUELE cliente ainda serve. Pra dar colisão o
-- mesmo cliente teria que ter se mudado pra outra casa de mesmo número, na
-- mesma rua e na mesma cidade.
--
-- A 0161 já tinha aberto essa exceção na mão pro caso do Flávio; agora vira a
-- regra, e some a inconsistência entre o backfill e o que roda no dia a dia.

CREATE OR REPLACE FUNCTION public.chave_endereco(
  p_rua text, p_numero text, p_bairro text, p_cidade text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  -- p_bairro continua na assinatura só pra não quebrar as chamadas existentes;
  -- de propósito ele NÃO entra no resultado.
  SELECT nullif(
    regexp_replace(
      lower(unaccent(btrim(concat_ws(' ',
        nullif(btrim(coalesce(p_rua, '')), ''),
        nullif(btrim(coalesce(p_numero, '')), ''),
        nullif(btrim(coalesce(p_cidade, '')), '')
      )))),
      '\s+', ' ', 'g'),
    '');
$function$;

COMMENT ON FUNCTION public.chave_endereco(text, text, text, text) IS
  'Identifica a casa por rua+numero+cidade. O bairro é ignorado de propósito: o cliente escreve diferente a cada pedido (mig 0162).';

-- As refs já gravadas foram calculadas COM bairro — recalcula todas, senão
-- nenhum pino salvo casaria mais e a taxa voltaria pro buscador.
UPDATE clientes
SET endereco_pin_ref = chave_endereco(endereco, numero, bairro, cidade)
WHERE endereco_pin_ref IS NOT NULL;

NOTIFY pgrst, 'reload schema';
