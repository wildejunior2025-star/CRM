import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Telemarketing (mig 0292): só o super admin cria o login de cada atendente.
// O atendente é um usuário do Auth + uma linha em tm_atendentes — SEM profile,
// então não enxerga nada do resto do sistema.
//   { acao: "criar", nome, email, password }
//   { acao: "senha", user_id, password }

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}
const resp = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } })

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) return resp({ ok: false, error: "Não autorizado" }, 401)

    const sbCaller = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user }, error: authError } = await sbCaller.auth.getUser()
    if (authError || !user) return resp({ ok: false, error: "Não autorizado" }, 401)

    const sb = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    )

    const { data: perfil } = await sb.from("profiles").select("perfil").eq("id", user.id).maybeSingle()
    if (perfil?.perfil !== "super_admin") return resp({ ok: false, error: "Sem permissão" }, 403)

    const body = await req.json().catch(() => ({}))
    const password = String(body.password ?? "")
    if (password.length < 6) return resp({ ok: false, error: "A senha deve ter no mínimo 6 caracteres" }, 400)

    if (body.acao === "senha") {
      const userId = String(body.user_id ?? "")
      const { data: existe } = await sb.from("tm_atendentes").select("user_id").eq("user_id", userId).maybeSingle()
      if (!existe) return resp({ ok: false, error: "Atendente não encontrado" }, 404)
      const { error } = await sb.auth.admin.updateUserById(userId, { password })
      if (error) return resp({ ok: false, error: error.message }, 400)
      return resp({ ok: true })
    }

    const nome = String(body.nome ?? "").trim()
    const email = String(body.email ?? "").trim().toLowerCase()
    if (!nome || !email) return resp({ ok: false, error: "nome e email são obrigatórios" }, 400)

    const { data: novo, error: erroCriar } = await sb.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { nome },
    })
    if (erroCriar || !novo?.user) {
      return resp({ ok: false, error: erroCriar?.message ?? "Erro ao criar usuário" }, 400)
    }

    const { error: erroLinha } = await sb.from("tm_atendentes").insert({ user_id: novo.user.id, nome })
    if (erroLinha) {
      // Não deixa o login órfão: sem a linha em tm_atendentes ele não serve pra nada.
      await sb.auth.admin.deleteUser(novo.user.id)
      return resp({ ok: false, error: erroLinha.message }, 400)
    }

    return resp({ ok: true, user_id: novo.user.id })
  } catch (e) {
    return resp({ ok: false, error: String((e as Error)?.message ?? e) }, 500)
  }
})
