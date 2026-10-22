import { useEffect, useMemo, useState } from 'react'

// Categoria que só vale em certa hora / certos dias (mig 0096 e 0220).
//
// Nasceu na Loja Online ("Quarta do Picolé") e ficou só lá. Quando o Braseiro
// montou o Happy Hour — preço de happy hour até as 20h, só no salão — apareceu
// o furo: a Mesa e o Salão, que são JUSTAMENTE as telas presenciais, liam o
// cardápio sem olhar hora nenhuma. O preço promocional ia continuar na tela às
// 21h, e o freio dependia de alguém lembrar de esconder a categoria na mão.
//
// Por isso a regra mora aqui agora, e as três telas chamam a MESMA função.
// Preço diferente na mesa e no cardápio é briga no balcão.
//
// Obs.: o robô do WhatsApp tem a cópia dele em SQL (`buscar_produto_cardapio`),
// porque ele responde dentro do banco. Mexeu aqui, confere lá.

/**
 * A categoria está vendendo AGORA?
 *
 * Sem horário e sem dias, vale sempre. Usa o relógio de Brasília
 * (America/Fortaleza) de propósito: quem está viajando continua vendo a
 * promoção no horário da loja, não no do aparelho dele.
 *
 * @param {{hora_inicio?: string|null, hora_fim?: string|null, dias_semana?: number[]|null}} cat
 */
export function categoriaAbertaAgora(cat) {
  if (!cat) return true

  const dias = cat.dias_semana
  if (Array.isArray(dias) && dias.length > 0) {
    const hojeBrasilia = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' })
    const diaSemana = new Date(`${hojeBrasilia}T12:00:00`).getDay()
    if (!dias.includes(diaSemana)) return false
  }

  const inicio = cat.hora_inicio
  const fim = cat.hora_fim
  if (!inicio || !fim) return true

  const agora = new Date().toLocaleTimeString('en-GB', {
    hour12: false, timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit',
  })
  const emMinutos = (t) => {
    const [hh, mm] = String(t).slice(0, 5).split(':').map(Number)
    return hh * 60 + mm
  }
  const n = emMinutos(agora), a = emMinutos(inicio), b = emMinutos(fim)
  // Janela que vira a noite (22:00–02:00) não é "início menor que fim".
  return a <= b ? (n >= a && n < b) : (n >= a || n < b)
}

/**
 * Quais itens da sacola são de categoria que NÃO vende agora?
 *
 * A Loja Online só escondia a categoria fechada; o que já estava na sacola
 * ficava lá. Foi assim que o pedido #1497 da CDBom saiu na quinta com o Gelo
 * da "Promoção de Quarta": a sacola era de quarta e ninguém conferiu de novo na
 * hora de fechar. Devolve os nomes (vazio = pode seguir). Sem rede, deixa
 * passar: não vale travar a venda por causa dessa conferência.
 */
export async function itensForaDoHorario(supabase, empresaId, itens) {
  const ids = [...new Set((itens ?? []).map(i => i.id ?? i.produto_id).filter(Boolean))]
  if (!ids.length) return []
  try {
    const [{ data: prods }, { data: cats }] = await Promise.all([
      supabase.from('produtos').select('id, categoria').in('id', ids),
      supabase.from('categorias').select('nome, hora_inicio, hora_fim, dias_semana').eq('empresa_id', empresaId),
    ])
    const porNome = porNomeDeCategoria(cats)
    const categoriaDe = new Map((prods ?? []).map(p => [String(p.id), p.categoria]))
    return itens
      .filter(i => {
        const c = categoriaDe.get(String(i.id ?? i.produto_id))
        return c && !categoriaAbertaAgora(porNome[c])
      })
      .map(i => i.nome)
  } catch {
    return []
  }
}

/** Monta { nomeDaCategoria: cat } pra quem já carregou a lista de categorias. */
export function porNomeDeCategoria(cats) {
  const mapa = {}
  for (const c of (cats ?? [])) mapa[c.nome] = c
  return mapa
}

/**
 * A lista de produtos já peneirada pelo horário — e REVISTA a cada minuto.
 *
 * O minuto importa: a tela do salão fica aberta o turno inteiro e a da mesa
 * fica aberta enquanto a turma come. Peneirar só na hora de carregar deixaria
 * o Happy Hour na tela às 21h pra quem abriu às 19h — justo quem está vendendo.
 */
export function useProdutosNoHorario(produtos, catInfo) {
  const [minuto, setMinuto] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setMinuto(m => m + 1), 60000)
    return () => clearInterval(t)
  }, [])
  return useMemo(
    () => (produtos ?? []).filter(p => !p.categoria || categoriaAbertaAgora(catInfo?.[p.categoria])),
    // `minuto` entra de propósito: é ele que faz a conta ser refeita com o relógio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [produtos, catInfo, minuto],
  )
}
