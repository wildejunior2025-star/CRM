import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Busca TODAS as linhas paginando. O Supabase/PostgREST corta em 1000 linhas por request,
// e sem isso lojas movimentadas perdem linhas silenciosamente (faturamento aparece menor
// do que o real). Passe uma função que MONTA a query (com .order() estável) — ela é chamada
// uma vez por página com .range() aplicado.
export async function fetchAll(makeQuery, page = 1000) {
  let from = 0, all = []
  for (;;) {
    const { data, error } = await makeQuery().range(from, from + page - 1)
    if (error) return { data: all, error }
    if (!data || data.length === 0) break
    all = all.concat(data)
    if (data.length < page) break
    from += page
  }
  return { data: all, error: null }
}
