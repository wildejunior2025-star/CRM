import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { ICONE_CATEGORIA } from '../lib/categoriasFinanceiro'

// Categorias de insumo que a PRÓPRIA loja criou ("Temperos" 🌿), com a figurinha (mig 0417).
// As padrão (Hortifruti, Carnes e frios…) continuam no código; aqui só as da loja.
// Um cache por loja, compartilhado: quem cria uma categoria avisa as outras telas abertas.

const cache = new Map()        // empresaId -> [{ nome, icone }]
const ouvintes = new Set()
const VAZIO = []

async function buscar(empresaId) {
  const { data } = await supabase.from('categorias_insumo').select('nome, icone').eq('empresa_id', empresaId).order('nome')
  cache.set(empresaId, data || [])
  ouvintes.forEach(fn => fn())
}

export const FIGURINHAS_CATEGORIA = [
  '🌿', '🧂', '🌶️', '🧄', '🧅', '🍅', '🥕', '🥔', '🌽', '🍋', '🍓', '🍌',
  '🍖', '🍗', '🥓', '🐟', '🦐', '🥚', '🥛', '🧈', '🍚', '🍝', '🫘', '🥜',
  '🍞', '🍰', '🍫', '🍯', '🍬', '🍦', '🍕', '🍔', '🥟', '🥫', '🫙', '🧃',
  '🍺', '🍷', '☕', '🧊', '🔥', '🧴', '🧽', '🧻', '🥡', '🍽️', '🔪', '📦',
]

export function useCategoriasInsumo(empresaId) {
  const [, tique] = useState(0)

  useEffect(() => {
    const fn = () => tique(n => n + 1)
    ouvintes.add(fn)
    if (empresaId && !cache.has(empresaId)) buscar(empresaId)
    return () => { ouvintes.delete(fn) }
  }, [empresaId])

  const proprias = cache.get(empresaId) || VAZIO

  const icone = useCallback((cat) => ICONE_CATEGORIA[cat] || proprias.find(c => c.nome === cat)?.icone || '📦', [proprias])

  const criar = useCallback(async (nome, figura) => {
    const { error } = await supabase.from('categorias_insumo')
      .upsert({ empresa_id: empresaId, nome, icone: figura }, { onConflict: 'empresa_id,nome' })
    if (!error) await buscar(empresaId)
    return error
  }, [empresaId])

  return { proprias, icone, criar }
}
