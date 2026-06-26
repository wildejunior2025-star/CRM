import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return new Response(JSON.stringify({ ok: false, error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    // Valida o JWT do chamador usando a anon key (sem privilégios extras)
    const sbCaller = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user: callerUser }, error: authError } = await sbCaller.auth.getUser()
    if (authError || !callerUser) {
      return new Response(JSON.stringify({ ok: false, error: "Não autorizado" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    // Usa service_role para operações admin — nunca exposta ao front-end
    const sbAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    )

    // Verifica que o chamador é admin ou super_admin e obtém empresa_id
    const { data: callerProfile, error: profileError } = await sbAdmin
      .from("profiles")
      .select("perfil, empresa_id")
      .eq("id", callerUser.id)
      .single()

    if (profileError || !callerProfile) {
      return new Response(JSON.stringify({ ok: false, error: "Perfil não encontrado" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    if (!["admin", "super_admin"].includes(callerProfile.perfil)) {
      return new Response(JSON.stringify({ ok: false, error: "Sem permissão para criar usuários" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const empresa_id = callerProfile.empresa_id

    const body = await req.json()
    const { nome, email, password, telefone } = body

    if (!nome || !email || !password) {
      return new Response(JSON.stringify({ ok: false, error: "nome, email e password são obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    if (password.length < 6) {
      return new Response(JSON.stringify({ ok: false, error: "A senha deve ter no mínimo 6 caracteres" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    // Cria o usuário no Auth — email_confirm: true pula o fluxo de confirmação
    const { data: newUser, error: createError } = await sbAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nome, telefone: telefone ?? null },
    })

    if (createError || !newUser?.user) {
      return new Response(JSON.stringify({ ok: false, error: createError?.message ?? "Erro ao criar usuário" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const newUserId = newUser.user.id

    // O trigger handle_new_user NÃO cria profile para usuários sem tipo_cadastro,
    // então fazemos UPSERT (cria se não existir) com perfil 'vendedor' e a empresa.
    const profileRow: Record<string, unknown> = {
      id: newUserId, perfil: "vendedor", empresa_id, nome, email: newUser.user.email,
    }
    if (telefone) profileRow.telefone = telefone

    const { error: updateError } = await sbAdmin
      .from("profiles")
      .upsert(profileRow, { onConflict: "id" })

    if (updateError) {
      // Usuário foi criado no Auth mas o profile não foi atualizado.
      // Registra o erro mas retorna sucesso parcial — admin pode corrigir na tela.
      console.error("Erro ao atualizar profile:", updateError.message)
      return new Response(
        JSON.stringify({
          ok: true,
          user_id: newUserId,
          warning: "Usuário criado mas perfil não foi atualizado: " + updateError.message,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    return new Response(JSON.stringify({ ok: true, user_id: newUserId }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})
