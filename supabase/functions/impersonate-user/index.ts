import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Valida que quem chama é super_admin
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) throw new Error('Sem autorização')

    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user } } = await supabaseUser.auth.getUser()
    if (!user) throw new Error('Usuário não autenticado')

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('perfil')
      .eq('id', user.id)
      .single()

    if (profile?.perfil !== 'super_admin') throw new Error('Acesso negado')

    const { user_id, redirect_to } = await req.json()
    if (!user_id) throw new Error('user_id obrigatório')

    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: (await supabaseAdmin.auth.admin.getUserById(user_id)).data.user?.email ?? '',
      options: { redirectTo: redirect_to ?? `${Deno.env.get('SUPABASE_URL')?.replace('.supabase.co', '')}/portal` }
    })

    if (error) throw error

    return new Response(
      JSON.stringify({ link: data.properties?.action_link }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
