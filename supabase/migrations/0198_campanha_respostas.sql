-- A resposta da campanha estava sendo PERDIDA.
--
-- O cliente clicava em "Pode mandar" / "Prefiro não receber", o robô respondia
-- certinho ("Show! 🙌" / "Beleza, não te mando mais") — mas o cadastro dele
-- continuava com aceita_campanha = null. Na primeira campanha da Estação,
-- 60 pessoas receberam, 11 leram, várias clicaram, e o banco ficou com ZERO
-- respostas registradas.
--
-- A causa: a Meta devolve o número de celular do Nordeste SEM o 9º dígito
-- (5584 8774-7166), enquanto o cadastro guarda com o 9 (84 98774-7166). O envio
-- da resposta já normalizava isso — por isso o cliente recebia o "Show!" — mas
-- o UPDATE no cadastro comparava o texto cru e não achava ninguém.
--
-- Aqui vão as duas metades do conserto:
--
-- 1. `campanha_respostas` guarda TODA resposta que chega, mesmo a que não casar
--    com cadastro nenhum e mesmo a que o robô não souber classificar. Resposta
--    de cliente não pode depender de o resto do sistema estar certo pra existir.
-- 2. `campanha_registrar_resposta` casa o telefone com `normalizar_tel_br`
--    (a mesma conta que o checkout da loja online já usa desde a 0092) e
--    devolve quantos cadastros foram marcados — 0 vira aviso no log em vez de
--    silêncio.

CREATE TABLE IF NOT EXISTS public.campanha_respostas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid REFERENCES public.empresas(id) ON DELETE CASCADE,
  telefone     text NOT NULL,
  texto        text,               -- o rótulo cru do botão, como a Meta mandou
  aceita       boolean,            -- true = quer, false = não quer, null = não deu pra entender
  clientes_marcados int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campanha_respostas_empresa_idx
  ON public.campanha_respostas (empresa_id, created_at DESC);

-- Resposta que não bateu com cadastro nenhum: é o que a gente quer achar rápido
-- quando o casamento de telefone quebrar de novo.
CREATE INDEX IF NOT EXISTS campanha_respostas_orfas_idx
  ON public.campanha_respostas (empresa_id) WHERE clientes_marcados = 0;

ALTER TABLE public.campanha_respostas ENABLE ROW LEVEL SECURITY;

-- Só o dono da loja enxerga as respostas dela. O webhook usa service_role.
DROP POLICY IF EXISTS campanha_respostas_da_empresa ON public.campanha_respostas;
CREATE POLICY campanha_respostas_da_empresa ON public.campanha_respostas
  FOR SELECT TO authenticated
  USING (empresa_id IN (SELECT empresa_id FROM public.profiles WHERE id = auth.uid()));

-- Guarda a resposta e marca o cadastro. Devolve quantos cadastros casaram.
CREATE OR REPLACE FUNCTION public.campanha_registrar_resposta(
  p_empresa_id uuid,
  p_telefone   text,
  p_texto      text,
  p_aceita     boolean
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_marcados int := 0;
BEGIN
  IF p_aceita IS NOT NULL THEN
    UPDATE public.clientes
       SET aceita_campanha        = p_aceita,
           campanha_respondida_em = now()
     WHERE empresa_id = p_empresa_id
       AND normalizar_tel_br(p_telefone) <> ''
       AND normalizar_tel_br(telefone) = normalizar_tel_br(p_telefone);
    GET DIAGNOSTICS v_marcados = ROW_COUNT;
  END IF;

  INSERT INTO public.campanha_respostas (empresa_id, telefone, texto, aceita, clientes_marcados)
  VALUES (p_empresa_id, p_telefone, p_texto, p_aceita, v_marcados);

  RETURN v_marcados;
END;
$$;

COMMENT ON FUNCTION public.campanha_registrar_resposta IS
  'Registra a resposta de campanha e marca o cadastro casando o telefone com ou sem o 9º dígito. Retorna quantos cadastros foram marcados.';
