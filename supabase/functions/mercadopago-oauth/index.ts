import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// OAuth do Mercado Pago (marketplace): a loja conecta a conta MP dela.
// Duas ações na mesma função:
//   • ?action=start  → front autenticado pede a URL de autorização (gera state)
//   • ?code&state    → callback do MP (navegador volta); troca code por token e salva
// Deploy com --no-verify-jwt (o callback do MP vem sem JWT; o start valida manualmente).

const CLIENT_ID     = Deno.env.get('MP_CLIENT_ID') ?? '736904729861760'
const CLIENT_SECRET = Deno.env.get('MP_CLIENT_SECRET') ?? ''
const REDIRECT_URI  = 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/mercadopago-oauth'
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY      = Deno.env.get('SUPABASE_ANON_KEY')!
const FALLBACK_BACK = 'https://app.fwcinter.com/minha-loja'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}
function redirect(to: string) {
  return new Response(null, { status: 302, headers: { ...CORS, Location: to } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const url   = new URL(req.url)
  const admin = createClient(SUPABASE_URL, SERVICE_KEY)

  // ── CALLBACK do Mercado Pago (?code&state) ────────────────────────────────
  const code  = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (code && state) {
    const { data: st } = await admin
      .from('mercadopago_oauth_state').select('*').eq('state', state).maybeSingle()
    const back = st?.return_url || FALLBACK_BACK
    if (!st) return redirect(`${FALLBACK_BACK}?mp=erro`)

    const tokenRes = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI,
      }),
    })
    const tk = await tokenRes.json()
    if (!tokenRes.ok || !tk.access_token) {
      console.error('MP oauth token error:', JSON.stringify(tk))
      await admin.from('mercadopago_oauth_state').delete().eq('state', state)
      return redirect(`${back}?mp=erro`)
    }

    const expiresAt = new Date(Date.now() + Number(tk.expires_in ?? 15552000) * 1000).toISOString()
    await admin.from('mercadopago_contas').upsert({
      empresa_id:    st.empresa_id,
      mp_user_id:    String(tk.user_id ?? ''),
      access_token:  tk.access_token,
      refresh_token: tk.refresh_token ?? null,
      public_key:    tk.public_key ?? null,
      expires_at:    expiresAt,
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'empresa_id' })
    await admin.from('empresas')
      .update({ mp_conectado: true, mp_seller_id: String(tk.user_id ?? '') })
      .eq('id', st.empresa_id)
    await admin.from('mercadopago_oauth_state').delete().eq('state', state)

    return redirect(`${back}?mp=ok`)
  }

  // ── START (front autenticado pede a URL de autorização) ───────────────────
  if (url.searchParams.get('action') === 'start') {
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'Não autorizado' }, 401)

    const { data: profile } = await admin
      .from('profiles').select('empresa_id').eq('id', user.id).maybeSingle()
    const empresaId = profile?.empresa_id
    if (!empresaId) return json({ error: 'Empresa não encontrada' }, 400)

    const newState  = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
    const returnUrl = url.searchParams.get('return_url') || FALLBACK_BACK
    await admin.from('mercadopago_oauth_state').insert({ state: newState, empresa_id: empresaId, return_url: returnUrl })

    const authUrl = 'https://auth.mercadopago.com.br/authorization'
      + `?client_id=${CLIENT_ID}`
      + '&response_type=code&platform_id=mp'
      + `&state=${newState}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    return json({ url: authUrl }, 200)
  }

  // ── DISCONNECT (front autenticado desliga a conta MP da loja) ─────────────
  if (url.searchParams.get('action') === 'disconnect') {
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ error: 'Não autorizado' }, 401)

    const { data: profile } = await admin
      .from('profiles').select('empresa_id').eq('id', user.id).maybeSingle()
    const empresaId = profile?.empresa_id
    if (!empresaId) return json({ error: 'Empresa não encontrada' }, 400)

    await admin.from('mercadopago_contas').delete().eq('empresa_id', empresaId)
    await admin.from('empresas').update({ mp_conectado: false, mp_seller_id: null }).eq('id', empresaId)
    return json({ ok: true }, 200)
  }

  return json({ error: 'Rota inválida' }, 400)
})
