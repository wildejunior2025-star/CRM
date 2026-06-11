import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { AuthContext } from './authContextValue'

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [empresa, setEmpresa] = useState(null)
  const [loading, setLoading] = useState(true)

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

    async function loadProfile(userId) {
      const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
      if (active) setProfile(data ?? null)
      await loadEmpresa(data?.empresa_id ?? null)
    }

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      if (data.session) await loadProfile(data.session.user.id)
      if (active) setLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      if (newSession) loadProfile(newSession.user.id)
      else {
        setProfile(null)
        setEmpresa(null)
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
    await supabase.auth.signOut()
  }

  async function refreshProfile() {
    if (!session) return
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .maybeSingle()
    setProfile(data ?? null)

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
    login,
    signup,
    logout,
    refreshProfile,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
