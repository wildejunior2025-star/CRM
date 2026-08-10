import { supabase } from './supabaseClient'

// Regra do nome do cliente (decisão do Wilde, 10/08/2026)
// ------------------------------------------------------
// Exigir telefone pra cadastrar travava o atendimento na mesa — no aperto o
// atendente tem o nome, não o número. Então o telefone voltou a ser opcional e
// quem passou a diferenciar dois clientes é o NOME: ele não pode repetir.
// Se já tem uma "Maria", a próxima entra como "Maria da esquina" — assim a
// dívida do fiado sempre tem dono certo.

// "José  da Silva" e "jose da silva" são a mesma pessoa pro nosso olho, então
// são o mesmo nome pro sistema: tira acento, cai pra minúsculo e junta espaços.
export const chaveNome = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

// Devolve o cliente que já usa esse nome (ou null se o nome está livre).
// `listaLocal` é a lista que a tela já tem na mão — evita ida ao banco no caso
// comum. O banco é conferido depois porque essa lista vem cortada por limit e
// pode estar velha (o outro caixa cadastrou agora). `ignorarId` é pra edição:
// o cliente não bate de duplicado com ele mesmo.
export async function clienteComMesmoNome(empresaId, nome, listaLocal = [], ignorarId = null) {
  const chave = chaveNome(nome)
  if (!chave || !empresaId) return null

  const local = (listaLocal ?? []).find(c => c.id !== ignorarId && chaveNome(c.nome) === chave)
  if (local) return local

  const alvo = String(nome).trim()
  let q = supabase.from('clientes').select('id, nome, telefone').eq('empresa_id', empresaId)
  // % e _ são curinga do ilike; nome com esses caracteres vai de igualdade exata.
  q = /[%_]/.test(alvo) ? q.eq('nome', alvo) : q.ilike('nome', alvo)
  if (ignorarId) q = q.neq('id', ignorarId)
  const { data } = await q.limit(1)
  return data?.[0] ?? null
}
