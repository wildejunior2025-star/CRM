import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { AuthContext } from './authContextValue'

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [empresa, setEmpresa] = useState(null)
  const [loading, setLoading] = useState(true)
  // true enquanto a busca do profile está em andamento. Diferencia
  // "ainda carregando" de "não tem profile" (caso do login social Google,
  // que só ganha profile ao finalizar o cadastro).
  const [profileLoading, setProfileLoading] = useState(true)
  // De quem é o profile que já está na mão. Serve pra saber se um evento de
  // auth é login de verdade ou só o token se renovando do mesmo usuário.
  const profileIdRef = useRef(null)

  useEffect(() => {
    let active = true

    async function loadEmpresa(empresaId) {
      if (!empresaId) {
        if (active) setEmpresa(null)
        return
      }
      const { data } = await supabase.from('empresas').select('*').eq('id', empresaId).maybeSingle()
      if (active) setEmpresa(data ?? null)
    }

    // `silencioso` = recarrega os dados sem levantar o profileLoading. É o que
    // salva a tela: o ProtectedRoute troca a página inteira por "Carregando..."
    // enquanto profileLoading estiver ligado, e isso DESMONTA o que estava
    // aberto. No celular o token se renova toda vez que o app volta de outro
    // aplicativo (a câmera, por exemplo) — sem isso, tirar uma foto derrubava
    // o cadastro que estava preenchido e a foto se perdia no caminho.
    async function loadProfile(userId, { silencioso = false } = {}) {
      if (active && !silencioso) setProfileLoading(true)
      const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
      if (active) { setProfile(data ?? null); profileIdRef.current = data?.id ?? null }
      await loadEmpresa(data?.empresa_id ?? null)
      if (active && !silencioso) setProfileLoading(false)
    }

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      if (data.session) await loadProfile(data.session.user.id)
      else if (active) setProfileLoading(false)
      if (active) setLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      if (newSession) {
        // Mesmo usuário de antes? Então é renovação de token / volta de outro
        // app: atualiza por baixo, sem piscar o "Carregando..." e sem desmontar
        // a tela que o dono está usando.
        loadProfile(newSession.user.id, { silencioso: profileIdRef.current === newSession.user.id })
      } else {
        setProfile(null)
        profileIdRef.current = null
        setEmpresa(null)
        setProfileLoading(false)
      }
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  async function login(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  async function signup(email, password, metadata) {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: metadata },
    })
    return { error }
  }

  async function logout() {
    localStorage.removeItem('crm_superadmin_backup')
    await supabase.auth.signOut()
  }

  async function voltarSuperAdmin() {
    const raw = localStorage.getItem('crm_superadmin_backup')
    if (!raw) return false
    localStorage.removeItem('crm_superadmin_backup')
    localStorage.removeItem('crm_view_as')

    let parsed
    try { parsed = JSON.parse(raw) } catch { return false }

    if (parsed.mode === 'view_as') return true

    const { access_token, refresh_token } = parsed
    const { error } = await supabase.auth.setSession({ access_token, refresh_token })
    return !error
  }

  async function refreshProfile() {
    if (!session) return
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .maybeSingle()
    setProfile(data ?? null)
    profileIdRef.current = data?.id ?? null

    if (data?.empresa_id) {
      const { data: empresaData } = await supabase
        .from('empresas')
        .select('*')
        .eq('id', data.empresa_id)
        .maybeSingle()
      setEmpresa(empresaData ?? null)
    } else {
      setEmpresa(null)
    }
  }

  const value = {
    session,
    user: session?.user ?? null,
    profile,
    empresa,
    perfil: profile?.perfil ?? null,
    loading,
    profileLoading,
    login,
    signup,
    logout,
    refreshProfile,
    voltarSuperAdmin,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
