import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Busca TODAS as linhas paginando. O Supabase/PostgREST corta em 1000 linhas por request,
// e sem isso lojas movimentadas perdem linhas silenciosamente (faturamento aparece menor
// do que o real). Passe uma função que MONTA a query (com .order() estável) — ela é chamada
// uma vez por página com .range() aplicado.
// A partir da 2a pagina pergunta VARIAS de uma vez. Era uma esperando a outra:
// o deposito (4 mil itens) gastava 5 idas em fila so pra montar a vitrine, e o
// cliente olhava tela branca no 4G. A ordem do resultado nao muda — o
// Promise.all devolve as respostas na ordem em que foram pedidas.
const PAGINAS_JUNTAS = 4

export async function fetchAll(makeQuery, page = 1000) {
  const primeira = await makeQuery().range(0, page - 1)
  if (primeira.error) return { data: [], error: primeira.error }
  let all = primeira.data ?? []
  if (all.length < page) return { data: all, error: null }

  let from = page
  for (;;) {
    const pedidos = []
    for (let i = 0; i < PAGINAS_JUNTAS; i++) {
      const ini = from + i * page
      pedidos.push(makeQuery().range(ini, ini + page - 1))
    }
    const respostas = await Promise.all(pedidos)
    let acabou = false
    for (const r of respostas) {
      if (r.error) return { data: all, error: r.error }
      const d = r.data ?? []
      all = all.concat(d)
      if (d.length < page) acabou = true
    }
    if (acabou) return { data: all, error: null }
    from += PAGINAS_JUNTAS * page
  }
}
