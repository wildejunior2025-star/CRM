import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Editar funcionário — e liberar o e-mail quando ele é excluído.
//
// Faltavam as duas pontas. Não dava pra editar: errou o nome ou o e-mail, o
// jeito era excluir e criar de novo. E excluir era só soft delete (ativo=false),
// então o e-mail continuava preso no Auth — recriar com o MESMO endereço dava
// "já existe", pra um funcionário que a tela jurava ter sumido.
//
// Duas ações:
//   editar  → nome, telefone, perfil, e-mail e senha (as duas últimas exigem
//             a chave de serviço, por isso não dá pra fazer direto do front).
//   liberar → excluindo: troca o e-mail por uma lápide (excluido+<id>@...) e
//             bloqueia o login. O cadastro e o histórico de entregas ficam de
//             pé; só o endereço é devolvido pra ser usado de novo.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  })

const PERFIS_OK = ["admin", "vendedor", "garcom", "cozinheiro", "entregador"]

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) return json({ ok: false, error: "Não autorizado" }, 401)

    const sbCaller = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    )
    const { data: { user: caller }, error: authError } = await sbCaller.auth.getUser()
    if (authError || !caller) return json({ ok: false, error: "Não autorizado" }, 401)

    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    )

    const { data: quemChama } = await sbAdmin
      .from("profiles").select("perfil, empresa_id").eq("id", caller.id).single()
    if (!quemChama) return json({ ok: false, error: "Perfil não encontrado" }, 403)
    if (!["admin", "super_admin"].includes(quemChama.perfil)) {
      return json({ ok: false, error: "Sem permissão para editar funcionários" }, 403)
    }

    const body = await req.json()
    const { user_id, acao, nome, email, senha, telefone, perfil } = body
    if (!user_id) return json({ ok: false, error: "user_id é obrigatório" }, 400)

    // O alvo tem que ser da MESMA loja de quem chama. Sem isto, um admin
    // editaria funcionário de outra loja só sabendo o id.
    const { data: alvo } = await sbAdmin
      .from("profiles").select("id, empresa_id, email").eq("id", user_id).single()
    if (!alvo) return json({ ok: false, error: "Funcionário não encontrado" }, 404)
    if (quemChama.perfil !== "super_admin" && alvo.empresa_id !== quemChama.empresa_id) {
      return json({ ok: false, error: "Esse funcionário não é da sua loja" }, 403)
    }
    if (user_id === caller.id && acao === "liberar") {
      return json({ ok: false, error: "Você não pode excluir a si mesmo" }, 400)
    }

    // ── Excluindo: devolve o e-mail e tranca o login ─────────────────────────
    if (acao === "liberar") {
      const lapide = `excluido+${user_id}@fwcinter.com`
      const { error } = await sbAdmin.auth.admin.updateUserById(user_id, {
        email: lapide, email_confirm: true, ban_duration: "876000h",
      })
      if (error) return json({ ok: false, error: error.message }, 400)
      await sbAdmin.from("profiles").update({ ativo: false, email: lapide }).eq("id", user_id)
      return json({ ok: true, email_liberado: alvo.email })
    }

    // ── Editando ────────────────────────────────────────────────────────────
    if (senha && String(senha).length < 6) {
      return json({ ok: false, error: "A senha deve ter no mínimo 6 caracteres" }, 400)
    }

    const mudancaAuth: Record<string, unknown> = {}
    if (email && email !== alvo.email) { mudancaAuth.email = email; mudancaAuth.email_confirm = true }
    if (senha) mudancaAuth.password = senha
    if (Object.keys(mudancaAuth).length) {
      const { error } = await sbAdmin.auth.admin.updateUserById(user_id, mudancaAuth)
      if (error) return json({ ok: false, error: error.message }, 400)
    }

    const patch: Record<string, unknown> = {}
    if (nome !== undefined) patch.nome = nome
    if (telefone !== undefined) patch.telefone = telefone || null
    if (email) patch.email = email
    if (perfil && PERFIS_OK.includes(perfil)) patch.perfil = perfil
    if (Object.keys(patch).length) {
      const { error } = await sbAdmin.from("profiles").update(patch).eq("id", user_id)
      if (error) return json({ ok: false, error: error.message }, 400)
    }

    return json({ ok: true })
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500)
  }
})
