// Bot v189 — link do Google Maps vira endereço escrito + link do pino (quem pede PRA OUTRA pessoa não tem como mandar a própria localização). v188 — pede a LOCALIZAÇÃO primeiro (CEP/escrito viram a saída); endereço em pedaços vira um só; pedido do robô nasce com o ponto. v187 — promessa de retorno vira chamado de verdade; busca perdoa erro de digitação. v186: endereço+taxa no fechamento. v185: pedido de endereço pergunta rua e bairro (CEP vira a saída alternativa). v184: vendia o CEP como atalho (escrever é só a saída de quem não sabe). v183: escrito guarda bairro/cidade. v182: cadastro sem e-mail.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import {
  responderSemIA, roboPausado, pausarPorAtendimentoHumano, chamadoAberto, abrirChamado,
  comoFicaNoDia, carregarExcecoes, hojeNaLoja, daquiADias,
} from "../_shared/respostaSemIA.ts"
import { guardarMidiaDoChat } from "../_shared/midiaDoChat.ts"

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? ""
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ?? "").replace(/\/$/, "")
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? ""
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_KEY      = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bot-test",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// Pedido de endereço. Pergunta a RUA e o BAIRRO, do jeito que o atendente
// pergunta — e do jeito que o robô do link faz. O CEP era o atalho na teoria:
// na prática quase ninguém sabe o próprio CEP de cabeça, e quem sabe tem que
// ir procurar. Rua e bairro o cliente responde sem levantar da cadeira, e é o
// bairro que define a taxa fixa.
//
// O CEP fica como saída pra quem preferir — o caminho dele continua inteiro,
// não mudou nada no resto do fluxo.
// Curto de propósito (pedido da loja, 15/09/2026): o passo a passo do clipe
// não ensinava ninguém, só alongava a mensagem.
const TEXTO_PEDIR_ENDERECO =
  "📍 Me manda sua *localização* ou o endereço (rua, número e bairro)."

// Quem vai buscar na loja fala de muitos jeitos — "retirar" era o único que o
// robô entendia.
const RE_RETIRADA = /\b(retir\w*|vou buscar|vou pegar a[ií]|vou pegar na loja|eu (busco|pego)|busco a[ií]|pego a[ií]|passo a[ií]|(buscar|pegar) (a[ií]|na loja|no balc[aã]o)|eu mesm[oa] (busco|pego|vou)|n[aã]o precisa entregar)\b/i

/** Depois do nome: endereço (com a saída da retirada à vista) ou, sem entrega, a retirada. */
function textoDepoisDoCadastro(aceitaDelivery: boolean, enderecoLoja: string, pgtoOpcoes: string): string {
  return aceitaDelivery
    ? `${TEXTO_PEDIR_ENDERECO}\n\n🏪 Vai *retirar* na loja? É só me dizer.`
    : `✅ Cadastro feito!\n\nPode retirar em: *${enderecoLoja}*.\n\nComo vai pagar: ${pgtoOpcoes}? 💳`
}

// ── "Quero falar com uma pessoa" ─────────────────────────────────────────────
// O robô de IA não tinha como pedir socorro: se ele não dava conta, continuava
// tentando até o cliente desistir. Isto abre o chamado que toca no gestor (o
// mesmo sino do robô do link) e cala o robô até alguém atender.
//
// Duas portas: o cliente pede ("quero falar com atendente"), ou o próprio
// modelo emite a ação chamar_atendente quando se vê perdido.
const PEDE_HUMANO = /\b(atendente|atendimento humano|falar com (uma )?pessoa|falar com (o |a )?(dono|gerente|vendedor|humano)|pessoa de verdade|alguem de verdade|algu[eé]m da loja|me transfere|transferir)\b/i

// ── handleAtualizar_carrinho ─────────────────────────────────────────────────
// Usa PATCH (update) + POST (insert) separados — upsert via on_conflict tem falhas intermitentes
async function handleAtualizar_carrinho(
  _supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  items: any[]
): Promise<{ ok: boolean; status?: number; body?: string }> {
  try {
    const now = new Date().toISOString()
    const phoneEnc = encodeURIComponent(phone)

    // 1. PATCH — atualiza linha existente
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/whatsapp_carrinho?empresa_id=eq.${empresaId}&phone=eq.${phoneEnc}`,
      {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal,count=exact",
        },
        body: JSON.stringify({ items, updated_at: now }),
      }
    )
    if (patchRes.ok) {
      const range = patchRes.headers.get("content-range") ?? ""
      const rowsAffected = parseInt(range.split("/")[1] ?? "0", 10)
      if (rowsAffected > 0) {
        console.log(`[Carrinho] PATCH ok: ${items.length} itens para ${phone}`)
        return { ok: true }
      }
      // 0 linhas → linha não existe, cai para INSERT
    } else {
      console.error(`[Carrinho] PATCH erro ${patchRes.status}:`, await patchRes.text())
    }

    // 2. INSERT — cria nova linha
    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_carrinho`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({ empresa_id: empresaId, phone, items, updated_at: now }),
    })
    const insBody = insRes.ok ? "" : await insRes.text()
    if (!insRes.ok) {
      console.error(`[Carrinho] INSERT erro ${insRes.status}:`, insBody)
      return { ok: false, status: insRes.status, body: insBody }
    }
    console.log(`[Carrinho] INSERT ok: ${items.length} itens para ${phone}`)
    return { ok: true }
  } catch (e: any) {
    console.error("[Carrinho] exceção:", e?.message ?? String(e))
    return { ok: false, body: String(e) }
  }
}

// ── handleVerificarCliente ───────────────────────────────────────────────────
async function handleVerificarCliente(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  busca: string,
  phone: string,
  phoneLocal: string,
  catalogoUrl: string,
  carrinho: any[]
): Promise<{ resposta: string | null; clienteId?: string; clienteNome?: string; cliente?: any }> {
  try {
    const buscaNorm = busca.trim().toLowerCase()
    const isEmail = buscaNorm.includes("@")
    let encontrado: any = null

    if (isEmail) {
      const { data } = await supabase
        .from("clientes")
        .select("id, nome, telefone, email, endereco, numero, bairro, cidade, cep")
        .eq("empresa_id", empresaId)
        .ilike("email", buscaNorm)
        .limit(1).maybeSingle()
      encontrado = data
    }

    if (!encontrado) {
      const buscaWith9 = /^\d{10}$/.test(buscaNorm)
        ? `${buscaNorm.slice(0, 2)}9${buscaNorm.slice(2)}`
        : buscaNorm
      const { data } = await supabase
        .from("clientes")
        .select("id, nome, telefone, email, endereco, numero, bairro, cidade, cep")
        .eq("empresa_id", empresaId)
        .or(`telefone.eq.${buscaNorm},telefone.eq.55${buscaNorm},telefone.eq.${buscaWith9},telefone.eq.55${buscaWith9}`)
        .limit(1).maybeSingle()
      encontrado = data
    }

    if (encontrado) {
      if (carrinho.length > 0) {
        await supabase.from("whatsapp_carrinho").upsert(
          {
            empresa_id: empresaId,
            phone,
            cliente_id: encontrado.id,
            items: carrinho,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "empresa_id,phone" }
        )
      }
      const resposta = carrinho.length > 0
        ? `✅ Encontrei seu cadastro! Olá, *${encontrado.nome}*! 😊\n\nDeseja *entrega* ou *retirada*?`
        : `✅ Encontrei seu cadastro! Olá, *${encontrado.nome}*!\n\nO que vai pedir? Catálogo: ${catalogoUrl}`
      return { resposta, clienteId: encontrado.id, clienteNome: encontrado.nome, cliente: encontrado }
    }
    return { resposta: null }
  } catch (e) {
    console.error("[Cadastro] erro:", e)
    return { resposta: null }
  }
}

// ── handleCadastrarCliente ───────────────────────────────────────────────────
// Regras:
//  - Cliente já tem profile (login no app) → só cria clientes, não muda indicado_por
//  - Cliente novo (sem profile) → cria auth user + linka na rede desta loja + cria clientes
async function handleCadastrarCliente(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  phoneLocal: string,
  nome: string,
  email: string | null,
  supabase_url: string,
  supabase_key: string,
  indicadorProfileId: string | null,
  enderecoDados?: { endereco?: string|null; numero?: string|null; complemento?: string|null; bairro?: string|null; cidade?: string|null; estado?: string|null; cep?: string|null }
): Promise<{ ok: boolean; clienteId?: string }> {
  try {
    const telCliente = phoneLocal
    const emailLogin = email ? email.trim().toLowerCase() : `${telCliente}@wpp.vendamais.app`

    // Se já existe como cliente desta loja, apenas registra no carrinho
    const { data: jaExiste } = await supabase
      .from("clientes")
      .select("id")
      .eq("empresa_id", empresaId)
      .eq("telefone", telCliente)
      .limit(1).maybeSingle()

    if (jaExiste) {
      await supabase.from("whatsapp_carrinho")
        .update({ cliente_id: jaExiste.id, updated_at: new Date().toISOString() })
        .eq("empresa_id", empresaId).eq("phone", phone)
      console.log(`[Cadastrar] cliente já existe id=${jaExiste.id}`)
      return { ok: true, clienteId: jaExiste.id }
    }

    // Cliente do WhatsApp é SÓ da loja — não cria conta no app (sem auth user, sem senha).
    const authUserId: string | null = null
    const profileJaExistia = false

    // 2. Cria cliente via fetch direto (bypass supabase-js)
    let clienteId: string | null = null
    try {
      const cliRes = await fetch(`${supabase_url}/rest/v1/clientes`, {
        method: "POST",
        headers: {
          "apikey": supabase_key, "Authorization": `Bearer ${supabase_key}`,
          "Content-Type": "application/json", "Prefer": "return=representation",
        },
        body: JSON.stringify({
          empresa_id: empresaId, nome, telefone: telCliente,
          email: email ? email.trim().toLowerCase() : null,
          user_id: authUserId,
          tipo: "pessoa_fisica", condicao_pagamento: "a_vista",
          limite_credito: 0, desconto_percentual: 0, desconto_minimo_pedido: 0,
          origem: "whatsapp",
          ...(enderecoDados?.endereco ? {
            endereco: enderecoDados.endereco, numero: enderecoDados.numero ?? null,
            complemento: enderecoDados.complemento ?? null, bairro: enderecoDados.bairro ?? null,
            cidade: enderecoDados.cidade ?? null, estado: enderecoDados.estado ?? null,
            cep: enderecoDados.cep ?? null,
          } : {}),
        }),
      })
      if (cliRes.ok) {
        const rows = JSON.parse(await cliRes.text())
        const row  = Array.isArray(rows) ? rows[0] : rows
        if (row?.id) clienteId = row.id
      }
    } catch (e) { console.error("[Cadastrar] INSERT exceção:", String(e)) }

    // Fallbacks para obter ID
    if (!clienteId) {
      const { data: porTel } = await supabase.from("clientes").select("id")
        .eq("empresa_id", empresaId).eq("telefone", telCliente).limit(1).maybeSingle()
      if (porTel) clienteId = porTel.id
    }
    if (!clienteId && authUserId) {
      const { data: porUid } = await supabase.from("clientes").select("id")
        .eq("empresa_id", empresaId).eq("user_id", authUserId).maybeSingle()
      if (porUid) clienteId = porUid.id
    }

    // 3. Linka rede de indicação SOMENTE se o profile foi criado agora
    //    Quem já tem conta no app já pertence à rede de alguém — não muda
    if (authUserId && indicadorProfileId && !profileJaExistia) {
      await supabase.from("profiles").update({ indicado_por: indicadorProfileId }).eq("id", authUserId)
    }

    // 3b. Salva endereço no profile global se ainda não tiver (evita "não informado" em outras lojas)
    if (authUserId && enderecoDados?.endereco) {
      await supabase.from("profiles").update({
        endereco:    enderecoDados.endereco,
        numero:      enderecoDados.numero      ?? null,
        complemento: enderecoDados.complemento ?? null,
        bairro:      enderecoDados.bairro      ?? null,
        cidade:      enderecoDados.cidade      ?? null,
        estado:      enderecoDados.estado      ?? null,
        cep:         enderecoDados.cep         ?? null,
      }).eq("id", authUserId).is("endereco", null)
    }

    // 4. Salva cliente_id no carrinho para próximas mensagens
    if (clienteId) {
      await supabase.from("whatsapp_carrinho")
        .update({ cliente_id: clienteId, updated_at: new Date().toISOString() })
        .eq("empresa_id", empresaId).eq("phone", phone)
      console.log(`[Cadastrar] criado id=${clienteId}`)
    }

    return { ok: !!clienteId, clienteId: clienteId ?? undefined }
  } catch (e: any) {
    console.error("[Cadastrar] exceção geral:", e?.message ?? String(e))
    return { ok: false }
  }
}

// ── resolveCepData — via banco PostgreSQL em sa-east-1 ──────────────────────
async function resolveCepData(
  supabase: ReturnType<typeof createClient>,
  cep: string
): Promise<{ rua: string; bairro: string; cidade: string; uf: string } | null> {
  try {
    let d: any = null
    for (let tentativa = 1; tentativa <= 4 && !d; tentativa++) {
      const { data, error } = await supabase.rpc("buscar_cep_sql", { p_cep: cep })
      if (error) { console.error(`[CEP] rpc erro (tent ${tentativa}):`, error.message); continue }
      if (data) { d = data; break }
    }
    if (!d || d.erro) return null
    return { rua: d.logradouro ?? "", bairro: d.bairro ?? "", cidade: d.localidade ?? "", uf: d.uf ?? "" }
  } catch (e: any) {
    console.error("[CEP] resolveCepData erro:", e?.message)
    return null
  }
}

async function handleBuscarCep(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  cep: string
): Promise<{ resposta: string }> {
  try {
    const cepClean = cep.replace(/\D/g, "").slice(0, 8)
    if (cepClean.length !== 8) return { resposta: "CEP inválido. Confere e me manda só os 8 números. 😊" }

    // A RPC faz http pro ViaCEP de dentro do Postgres e falha de forma intermitente
    // (retorna null às vezes) — tenta até 4x antes de desistir.
    let d: any = null
    for (let tentativa = 1; tentativa <= 4 && !d; tentativa++) {
      const { data, error } = await supabase.rpc("buscar_cep_sql", { p_cep: cepClean })
      if (error) { console.error(`[CEP] rpc erro (tent ${tentativa}):`, error.message); continue }
      if (data) { d = data; break }
      console.log(`[CEP] null na tentativa ${tentativa}, retry...`)
    }

    if (!d) {
      return { resposta: "Não consegui buscar o CEP agora. 😕 Me informa:\n• Nome da rua\n• Número\n• Bairro\n• Cidade" }
    }
    if (d.erro) {
      return { resposta: "CEP não encontrado. 😕 Confere o CEP e me manda de novo." }
    }

    const logradouro = d.logradouro ?? ""
    const bairro     = d.bairro     ?? ""
    const localidade = d.localidade ?? ""
    const uf         = d.uf         ?? ""

    console.log(`[CEP] ok: ${logradouro}, ${localidade}/${uf}`)

    if (!localidade && !bairro) {
      return { resposta: "Não consegui buscar o CEP agora. 😕 Me informa:\n• Nome da rua\n• Número\n• Bairro\n• Cidade" }
    }

    const now = new Date().toISOString()
    const phoneEnc = encodeURIComponent(phone)

    // Salva endereço: PATCH primeiro, se não afetar linhas faz INSERT (cria carrinho vazio)
    async function salvarEndereco(campos: Record<string, any>) {
      const patchRes = await fetch(
        `${SUPABASE_URL}/rest/v1/whatsapp_carrinho?empresa_id=eq.${empresaId}&phone=eq.${phoneEnc}`,
        { method: "PATCH", headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal,count=exact" },
          body: JSON.stringify({ ...campos, updated_at: now }) }
      )
      if (patchRes.ok) {
        const range = patchRes.headers.get("content-range") ?? ""
        if (parseInt(range.split("/")[1] ?? "0", 10) > 0) return
      }
      // Linha não existe — cria com items vazio
      await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_carrinho`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ empresa_id: empresaId, phone, items: [], ...campos, updated_at: now }),
      })
    }

    // CEP sem logradouro (CEP genérico de bairro/cidade)
    if (!logradouro) {
      await salvarEndereco({ endereco_rua: null, endereco_numero: null, endereco_bairro: bairro || null, endereco_cidade: localidade || null, endereco_estado: uf || null })

      const linhas = [
        `✅ CEP encontrado!`,
        ``,
        bairro     ? `🏘️ *Bairro:* ${bairro}`    : null,
        localidade ? `🏙️ *Cidade:* ${localidade}` : null,
        uf         ? `🗺️ *Estado:* ${uf}`         : null,
        ``,
        `Esse CEP não tem uma rua específica. Me informa o *nome da rua* da sua casa? 😊`,
      ].filter(l => l !== null).join("\n")
      return { resposta: linhas }
    }

    // CEP com logradouro completo
    await salvarEndereco({ endereco_rua: logradouro, endereco_numero: null, endereco_bairro: bairro, endereco_cidade: localidade, endereco_estado: uf || null })

    const linhas = [
      `✅ Encontrei seu endereço:`,
      ``,
      `📍 *Rua:* ${logradouro}`,
      bairro     ? `🏘️ *Bairro:* ${bairro}`    : null,
      localidade ? `🏙️ *Cidade:* ${localidade}` : null,
      uf         ? `🗺️ *Estado:* ${uf}`         : null,
      ``,
      `Qual o *número* da sua casa? 😊`,
    ].filter(l => l !== null).join("\n")

    return { resposta: linhas }
  } catch (e: any) {
    console.error("[CEP] erro geral:", e?.message ?? String(e))
    return { resposta: "Não consegui buscar o CEP agora. 😕 Me informa:\n• Nome da rua\n• Número\n• Bairro\n• Cidade" }
  }
}

// ── handleSalvarRua ──────────────────────────────────────────────────────────
async function handleSalvarRua(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  rua: string,
  bairro?: string | null,
  cidade?: string | null,
  estado?: string | null
): Promise<{ resposta: string }> {
  try {
    // Bairro e cidade também são salvos quando vêm junto (cliente que digitou o
    // endereço sem CEP). Sem eles a taxa sai errada: o bairro define a taxa fixa e,
    // no cálculo por km, o mapa procuraria a rua no Brasil inteiro.
    // Cria a sacola se ainda não existe: quem só pergunta "entrega na Redinha?"
    // e manda o endereço não tinha linha, o update não gravava nada e o número
    // respondia "Não encontrei o endereço salvo" (CDBom, 15/09/2026).
    await salvarEnderecoNoCarrinho(empresaId, phone, {
      endereco_rua: rua,
      ...(bairro ? { endereco_bairro: bairro } : {}),
      ...(cidade ? { endereco_cidade: cidade } : {}),
      ...(estado ? { endereco_estado: estado } : {}),
    })

    const detalhe = [rua, bairro, cidade].filter(Boolean).join(" — ")
    return { resposta: `✅ Endereço salvo!\n\n📍 ${detalhe}\n\nQual o *número* da sua casa? 😊` }
  } catch (e: any) {
    console.error("[Rua] exceção:", e?.message ?? String(e))
    return { resposta: "Não consegui salvar a rua. Pode repetir?" }
  }
}

// ── Endereço escrito à mão ───────────────────────────────────────────────────
// "Rua Eliane Barros, 600, Novo Amarante" → rua, número e bairro.
//
// Existe porque o modelo às vezes CONVERSA sobre o endereço e não emite
// salvar_rua: ele responde "confirmei: Rua tal, 600, Novo Amarante" e segue
// adiante com o cadastro vazio. Aí, na hora de fechar, não tem endereço, a taxa
// não é calculada e o pedido não sai. Aqui o sistema grava sem depender dele.
const PREFIXO_RUA = /^(rua|r[.]|av|av[.]|avenida|travessa|trav|estrada|rod|rodovia|praca|praça|alameda|al[.]|beco|conj|conjunto|quadra|qd|loteamento|sitio|sítio|vila)[ .]/i

// "O endereço:\nAvenida dos Expedicionários 565\nParque dos coqueiros" → sem o
// rótulo e com as linhas viradas vírgula. Com o rótulo na frente o endereço
// não era reconhecido, o robô dizia "Anotei" sem gravar e a taxa nunca saía
// (CDBom, 14/09/2026 — terminou em chamado de atendente).
function limparRotuloEndereco(txt: string): string {
  return String(txt ?? "")
    .replace(/^\s*(?:(?:o|meu|segue(?: o)?|esse [ée] o|aqui (?:vai|est[áa]) o)\s+)?(?:endere[çc]o|end\.?)\s*(?:[ée]\s*)?[:\-–]?\s*/i, "")
    .replace(/^\s*(?:entregar|entrega|mora|moro)\s+(?:na|no|em)\s+/i, "")
    .split(/\n+/).map(l => l.trim()).filter(Boolean).join(", ")
    .trim()
}

function lerEnderecoEscrito(txt: string): { rua: string; numero: string | null; bairro: string | null } | null {
  const bruto = limparRotuloEndereco(txt)
  if (bruto.length < 8 || bruto.length > 160) return null
  const partes = bruto.split(",").map(p => p.trim()).filter(Boolean)
  let rua = partes[0] ?? ""
  let numero: string | null = null
  let bairro: string | null = partes[1] ?? null

  // Número colado na rua ("Rua Eliane Barros 600") ou na própria vírgula.
  const comNumero = rua.match(/^(.+?)[ ,]+(?:n[º°o.]?\s*)?(\d{1,5}[a-zA-Z]?)$/i)
  if (comNumero) { rua = comNumero[1].trim(); numero = comNumero[2] }
  // Tudo sem vírgula: "rua eliane barros 600 novo amarante". Antes a frase
  // inteira virava o nome da rua — sem bairro a taxa caía na distância (R$ 5
  // em vez dos R$ 4 do bairro) e o número nunca era salvo. Pega o ÚLTIMO
  // número ("Rua 7 de Setembro 120 Centro" → rua "Rua 7 de Setembro"), e o
  // que vem depois só vale como bairro se não tiver dígito.
  // Só com prefixo de rua: sem ele, "quero 10 picolé" virava rua "quero".
  if (!numero && PREFIXO_RUA.test(rua)) {
    const noMeio = rua.match(/^(.+?)\s+(?:n[º°o.]?\s*)?(\d{1,5}[a-zA-Z]?)\s+(?:[-–]\s*)?(?:bairro\s+)?([^\d]{3,50})$/i)
    if (noMeio) {
      rua = noMeio[1].trim()
      numero = noMeio[2]
      // Colado no número é o bairro; o que vier depois da vírgula costuma ser a cidade.
      bairro = noMeio[3].trim()
    }
  }
  if (!numero && bairro && /^\d{1,5}[a-zA-Z]?$/.test(bairro)) {
    numero = bairro
    bairro = partes[2] ?? null
  }
  if (!rua || rua.length < 5) return null
  // Sem prefixo de rua e sem número, é conversa, não endereço.
  if (!PREFIXO_RUA.test(rua) && !numero) return null
  return { rua, numero, bairro: bairro && bairro.length >= 3 ? bairro : null }
}

/**
 * Cidade REAL da rua que o cliente escreveu.
 *
 * Quando ele diz só "Rua Eliane Barros, 600, Novo Amarante", o sistema
 * completava com a cidade da LOJA — e o pedido #1063 saiu com "Natal" numa rua
 * que fica em São Gonçalo do Amarante. O entregador lê isso. Aqui o mapa
 * responde: acha o ponto pela rua + bairro e pergunta de volta em que cidade
 * ele caiu.
 */
async function descobrirCidade(rua: string, bairro: string | null, estado: string | null, cidadeLoja: string | null): Promise<string | null> {
  try {
    const ponto = await geocodificarEndereco([rua, bairro, estado].filter(Boolean).join(", "))
    if (!ponto) return cidadeLoja
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${ponto.lat}&lon=${ponto.lng}&format=json&addressdetails=1`,
      { headers: { "User-Agent": "CRM-FWC/1.0" } },
    )
    const d = await res.json()
    const a = d?.address ?? {}
    const cidade = a.city ?? a.town ?? a.municipality ?? a.village ?? a.county ?? null
    if (cidade) console.log(`[Geo] cidade do endereço: ${cidade}`)
    return cidade ?? cidadeLoja
  } catch (e: any) {
    console.error("[Geo] reverse erro:", e?.message)
    return cidadeLoja
  }
}

// ── O PONTO QUE O CLIENTE MANDOU (mig 0239) ─────────────────────────────────
//
// O pininho do WhatsApp é o endereço mais confiável que existe nessa conversa:
// veio do celular dele, não da memória dele nem do chute do buscador de mapa.
// Só falta o NÚMERO da casa, que GPS não sabe dizer.
//
// Quem lê isto é o CÓDIGO, não o modelo. O robô não tem como "esquecer" de
// salvar, não gasta crédito pra entender um pino, e não corre o risco de
// responder "não entendi" pra quem fez exatamente o que foi pedido.

// Coordenada → endereço escrito. É o caminho inverso do buscador: o mapa sabe
// dizer a rua, o bairro e a cidade daquele ponto.
async function enderecoDoPonto(lat: number, lng: number): Promise<
  { rua: string; bairro: string; cidade: string; estado: string; cep: string } | null
> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
      { headers: { "User-Agent": "CRM-FWC/1.0" } },
    )
    const d = await res.json()
    const a = d?.address ?? {}
    return {
      rua:    a.road ?? a.pedestrian ?? a.footway ?? "",
      bairro: a.suburb ?? a.neighbourhood ?? a.city_district ?? "",
      cidade: a.city ?? a.town ?? a.municipality ?? a.village ?? a.county ?? "",
      estado: String(a["ISO3166-2-lvl4"] ?? "").split("-")[1] ?? "",
      cep:    String(a.postcode ?? "").replace(/\D/g, ""),
    }
  } catch (e: any) {
    console.error("[Local] reverse erro:", e?.message)
    return null
  }
}

// Grava campos de endereço no carrinho. PATCH primeiro; se a linha não existe
// ainda (cliente que mandou a localização antes de escolher qualquer coisa),
// cria com a sacola vazia.
async function salvarEnderecoNoCarrinho(
  empresaId: string, phone: string, campos: Record<string, unknown>,
): Promise<void> {
  const phoneEnc = encodeURIComponent(phone)
  const now = new Date().toISOString()
  const h = {
    "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
  }
  const patch = await fetch(
    `${SUPABASE_URL}/rest/v1/whatsapp_carrinho?empresa_id=eq.${empresaId}&phone=eq.${phoneEnc}`,
    { method: "PATCH", headers: { ...h, "Prefer": "return=minimal,count=exact" },
      body: JSON.stringify({ ...campos, updated_at: now }) },
  )
  if (patch.ok) {
    const range = patch.headers.get("content-range") ?? ""
    if (parseInt(range.split("/")[1] ?? "0", 10) > 0) return
  }
  await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_carrinho`, {
    method: "POST",
    headers: { ...h, "Prefer": "return=minimal" },
    body: JSON.stringify({ empresa_id: empresaId, phone, items: [], ...campos, updated_at: now }),
  })
}

async function handleLocalizacao(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  coords: { lat: number; lng: number },
): Promise<{ resposta: string }> {
  const a = await enderecoDoPonto(coords.lat, coords.lng)

  // O ponto vale mesmo quando o mapa não sabe dizer a rua: é ele que guia o
  // motoboy. O texto do endereço a gente pergunta.
  const campos: Record<string, unknown> = {
    endereco_lat: coords.lat,
    endereco_lng: coords.lng,
  }
  if (a?.rua) {
    campos.endereco_rua = a.rua
    // Número NÃO vem do GPS. Fica em branco de propósito: é a única coisa que
    // ainda precisa ser perguntada.
    campos.endereco_numero = null
    if (a.bairro) campos.endereco_bairro = a.bairro
    if (a.cidade) campos.endereco_cidade = a.cidade
    if (a.estado) campos.endereco_estado = a.estado
  }
  await salvarEnderecoNoCarrinho(empresaId, phone, campos)
  console.log(`[Local] ponto salvo: ${coords.lat},${coords.lng} rua="${a?.rua ?? "-"}"`)

  // O link do mapa vai SEMPRE junto (CDBom, 14/09/2026). O nome da rua que o
  // mapa devolve é só a rua mais perto do GPS: o cliente num quiosque em frente
  // à "casa da banana" recebeu "Rua Palmácea", corrigiu pra "Avenida das
  // Mangueiras", disse que não tinha número — e o endereço nunca fechou. O que
  // guia o motoboy é o PINO; com o link o cliente confere e arrasta até a porta.
  // O pino é onde o CELULAR está, e quem pede do trabalho manda o do trabalho:
  // o link também é a chance de pegar isso antes de a comida sair.
  let link = ""
  {
    const { data: pin, error: pinErr } = await supabase.rpc("criar_pin_link_para", {
      p_empresa_id: empresaId, p_telefone: phone,
      p_rua: a?.rua || "Localização enviada pelo WhatsApp", p_numero: null,
      p_bairro: a?.bairro || null, p_cidade: a?.cidade || null,
      p_estado: a?.estado || null, p_cep: null,
      p_lat: coords.lat, p_lng: coords.lng, p_pedido_id: null,
    })
    if (pinErr) console.error("[Local] criar_pin_link_para erro:", pinErr.message)
    else if (pin?.ok) link = `https://lojaonline.fwcinter.com/local/${pin.token}`
  }
  const blocoLink = link
    ? `📌 Confere se o ponto está certinho na sua porta — se não estiver, é só arrastar:\n👉 ${link}\n\n`
    : ""

  if (!a?.rua) {
    return { resposta:
      "📍 Peguei sua localização, obrigado!\n\n" + blocoLink +
      "O mapa não soube me dizer o nome da rua aí. Me escreve o *nome da rua* e o *número* " +
      "(se não tiver número, é só dizer *sem número*). 🙂" }
  }

  const onde = [a.rua, a.bairro || null, a.cidade || null].filter(Boolean).join(", ")
  return { resposta:
    "📍 Peguei sua localização!\n\n" +
    `Pelo mapa fica perto de *${onde}*.\n\n` + blocoLink +
    "Agora me diz o *número* da casa. Não tem número? Responda *sem número*. 😊" }
}

// ── LINK DO GOOGLE MAPS (mig 0240) ──────────────────────────────────────────
//
// Quem pede PRA OUTRA PESSOA não pode mandar a própria localização: o GPS dele
// é o lugar errado. O que essa pessoa faz é colar um link do Maps.
//
// O link tem duas coisas dentro, e as duas servem:
//   • às vezes a coordenada (@-5.76,-35.27 ou !3d..!4d..), quando é pino solto;
//   • quase sempre o endereço ESCRITO e completo, com número, bairro e CEP.
//
// Então o robô lê o que der, escreve o endereço na conversa e devolve o NOSSO
// link do mapa (mig 0238) pra pessoa arrastar o pino até a porta certa. Ela sabe
// onde o amigo mora — foi ela que achou o lugar no Maps.
//
// Por que não confiar no link e pronto: link de LUGAR aponta pro estabelecimento
// (o cliente manda o mercado da esquina como referência), não pra casa. Por isso
// a resposta pergunta de volta, sempre.

const RE_LINK_MAPA = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.)?google\.[a-z\.]+\/maps|maps\.google\.[a-z\.]+)[^\s]*/i

// O link curto não diz nada: o endereço mora no destino do redirecionamento.
async function resolverLinkDoMapa(url: string): Promise<string | null> {
  let atual = url
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(atual, {
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CRM-FWC/1.0)" },
      })
      const loc = res.headers.get("location")
      if (!loc) return atual
      atual = loc.startsWith("http") ? loc : new URL(loc, atual).toString()
    } catch (e: any) {
      console.error("[Mapa] redirect erro:", e?.message)
      return null
    }
  }
  return atual
}

function pontoDoLinkDoMapa(url: string): { lat: number; lng: number } | null {
  let u = url
  try { u = decodeURIComponent(url) } catch { /* url torta: usa como veio */ }
  // !3d/!4d é o PONTO DO LUGAR. O @ é só onde a CÂMERA do mapa estava — pode
  // ficar a centenas de metros dali (no link do hospital deu quase 1 km de
  // diferença). A ordem importa: o mais preciso primeiro.
  const padroes = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&](?:q|query|ll|daddr|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
  ]
  for (const re of padroes) {
    const m = u.match(re)
    if (m) {
      const lat = parseFloat(m[1]), lng = parseFloat(m[2])
      if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) return { lat, lng }
    }
  }
  return null
}

// "Nordestão Igapó - Av. Bacharel Tomaz Landim, 26 - Igapó, Natal - RN, 59290-000"
// vira rua/número/bairro/cidade/UF/CEP, e o que vier antes da rua é o nome do
// lugar — que serve de REFERÊNCIA pro entregador, não de endereço.
function enderecoDoLinkDoMapa(url: string):
  { rua: string; numero: string; bairro: string; cidade: string; estado: string; cep: string; lugar: string } | null {
  const m = url.match(/\/maps\/place\/([^/@?]+)/)
  if (!m) return null
  let t = ""
  try { t = decodeURIComponent(m[1].replace(/\+/g, " ")).trim() } catch { return null }
  if (t.length < 6) return null

  const cepM = t.match(/(\d{5}-?\d{3})/)
  const cep = cepM ? cepM[1].replace(/[^0-9]/g, "") : ""
  if (cepM) t = t.replace(cepM[0], "")
  t = t.replace(/[,\s-]+$/, "").trim()

  const ufM = t.match(/[-,]\s*([A-Z]{2})\s*$/)
  const estado = ufM ? ufM[1] : ""
  if (ufM) t = t.slice(0, ufM.index).replace(/[,\s-]+$/, "").trim()

  const blocos = t.split(" - ").map(b => b.trim()).filter(Boolean)
  let rua = "", numero = "", idxRua = -1
  for (let i = 0; i < blocos.length; i++) {
    const comNum = blocos[i].match(/^(.+?),\s*(\d{1,6}[A-Za-z]?)$/)
    if (comNum) { rua = comNum[1].trim(); numero = comNum[2]; idxRua = i; break }
  }
  if (idxRua < 0) {
    for (let i = 0; i < blocos.length; i++) {
      if (PREFIXO_RUA.test(blocos[i])) { rua = blocos[i]; idxRua = i; break }
    }
  }
  if (!rua) return null

  let bairro = "", cidade = ""
  const resto = blocos.slice(idxRua + 1).join(" - ")
  if (resto) {
    const partes = resto.split(",").map(x => x.trim()).filter(Boolean)
    if (partes.length >= 2) { bairro = partes[0]; cidade = partes[1] }
    else if (partes.length === 1) { cidade = partes[0] }
  }
  const lugar = idxRua > 0 ? blocos.slice(0, idxRua).join(" - ") : ""
  return { rua, numero, bairro, cidade, estado, cep, lugar }
}

async function handleLinkDoMapa(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  url: string,
): Promise<{ resposta: string }> {
  const destino = await resolverLinkDoMapa(url)
  if (!destino) {
    return { resposta: "Não consegui abrir esse link. \u{1F615} Me escreve o endereço da entrega: *rua*, *número* e *bairro*?" }
  }
  const ponto = pontoDoLinkDoMapa(destino)
  const end   = enderecoDoLinkDoMapa(destino)
  console.log(`[Mapa] destino="${destino.slice(0, 120)}" ponto=${ponto ? `${ponto.lat},${ponto.lng}` : "-"} rua="${end?.rua ?? "-"}"`)

  // Link de LUGAR muitas vezes traz só o NOME ("/maps/place/Hospital+X/") e
  // nenhum endereço escrito. Mas traz o ponto — e ponto a gente sabe virar
  // endereço, do mesmo jeito que faz com a localização que o cliente manda.
  // Sem isto o robô respondia "(o link só trouxe o ponto no mapa)" e ficava
  // esperando um endereço que estava ali, a uma consulta de distância.
  let endFinal = end
  if (!endFinal?.rua && ponto) {
    const a = await enderecoDoPonto(ponto.lat, ponto.lng)
    if (a?.rua) {
      endFinal = { rua: a.rua, numero: "", bairro: a.bairro, cidade: a.cidade, estado: a.estado, cep: a.cep, lugar: end?.lugar ?? "" }
      console.log(`[Mapa] endereço veio do ponto: ${a.rua}, ${a.bairro}`)
    }
  }

  if (!endFinal && !ponto) {
    return { resposta: "Esse link não me disse o endereço. \u{1F615} Me escreve aqui: *rua*, *número* e *bairro*?" }
  }

  const campos: Record<string, unknown> = {}
  if (endFinal) {
    campos.endereco_rua    = endFinal.rua
    campos.endereco_numero = endFinal.numero || null
    if (endFinal.bairro) campos.endereco_bairro = endFinal.bairro
    if (endFinal.cidade) campos.endereco_cidade = endFinal.cidade
    if (endFinal.estado) campos.endereco_estado = endFinal.estado
  }
  if (ponto) { campos.endereco_lat = ponto.lat; campos.endereco_lng = ponto.lng }
  await salvarEnderecoNoCarrinho(empresaId, phone, campos)

  // O link do mapa NOSSO: quem está com o celular na mão arrasta o pino até a
  // porta do amigo. É o único jeito de acertar a casa de outra pessoa.
  let linkPino = ""
  if (endFinal?.rua) {
    const { data, error } = await supabase.rpc("criar_pin_link_para", {
      p_empresa_id: empresaId, p_telefone: phone,
      p_rua: endFinal.rua, p_numero: endFinal.numero || null,
      p_bairro: endFinal.bairro || null, p_cidade: endFinal.cidade || null,
      p_estado: endFinal.estado || null, p_cep: endFinal.cep || null,
      p_lat: ponto?.lat ?? null, p_lng: ponto?.lng ?? null, p_pedido_id: null,
    })
    if (error) console.error("[Mapa] criar_pin_link_para erro:", error.message)
    else if (data?.ok) linkPino = `https://lojaonline.fwcinter.com/local/${data.token}`
  }

  const escrito = [
    endFinal?.rua ? `*${[endFinal.rua, endFinal.numero].filter(Boolean).join(", ")}*` : null,
    [endFinal?.bairro, endFinal?.cidade].filter(Boolean).join(", ") || null,
  ].filter(Boolean).join(" \u2014 ")

  const linhas = [
    "\u{1F4CD} Peguei o endereço do link:",
    "",
    escrito || "(o link só trouxe o ponto no mapa)",
    endFinal?.lugar ? `_referência: ${endFinal.lugar}_` : null,
    "",
    linkPino
      ? "Confere o ponto exato aqui, que aí o entregador vai direto na porta:\n\n"
        + `\u{1F449} ${linkPino}\n\n`
        + 'Se estiver em casa agora, é só tocar em *usar minha localização*. \u{1F642}'
      : null,
    "",
    endFinal?.numero ? "Esse é o endereço da entrega?" : "Qual o *número* da casa?",
  ].filter(l => l !== null).join("\n")

  return { resposta: linhas }
}

// ── Endereço que chega em pedaços ────────────────────────────────────────────
//
// Muita gente escreve o endereço em duas mensagens: "Rua Eliane Barros" numa,
// "Novo Amarante" na outra — às vezes o número numa terceira. Pra quem digita é
// UM endereço só. Pro robô eram mensagens soltas: a rua era salva e a segunda
// não virava nada, porque não tem prefixo de rua nem número. O bairro ficava
// vazio, e é o bairro que define a taxa fixa da loja.
//
// A regra é estreita de propósito: só vale quando a rua JÁ está salva, o bairro
// AINDA não está, e o robô tinha acabado de perguntar endereço/número. Fora
// disso, "Novo Amarante" é só uma palavra numa conversa.

// Palavras que aparecem sozinhas numa conversa e NÃO são bairro. Sem esta
// lista, um "obrigado" ou um "pode ser" viraria o bairro do cliente.
const NAO_E_BAIRRO = new RegExp("^(" + [
  "sim", "s", "nao", "não", "n", "ok", "okay", "blz", "beleza", "certo", "isso",
  "obrigad[oa]", "vlw", "valeu", "por favor", "pfv", "pode ser", "claro", "aham",
  "entrega", "entregar", "retirada", "retirar", "buscar", "delivery",
  "pix", "dinheiro", "cartao", "cartão", "debito", "débito", "credito", "crédito",
  "bom dia", "boa tarde", "boa noite", "oi", "ola", "olá", "e ai", "e aí",
  "quanto", "quanto custa", "tem", "quero", "sei nao", "sei não", "nao sei", "não sei",
  "espera", "calma", "ja mando", "já mando", "so um minuto", "só um minuto",
  "atendente", "pessoa", "cancelar", "cancela",
].join("|") + ")[.!?]*$", "i")

// Confirmação repetida ("sim sim", "ok ok", "isso mesmo") não é nome.
const SO_CONFIRMACAO = /^((sim|s|ok|okay|isso|certo|pode|claro|beleza|blz|show|perfeito|mesmo|ser|t[aá]|bom|n[aã]o|obrigad[oa])[\s,.!]*)+$/i

function pareceNomeDePessoa(txt: string): boolean {
  const t = String(txt ?? "").trim()
  return /^[A-Za-zÀ-ÿ' .-]{2,40}$/.test(t) && t.split(/\s+/).length <= 5 && !NAO_E_BAIRRO.test(t) && !SO_CONFIRMACAO.test(t) && !RE_RETIRADA.test(t)
}

/**
 * O nome entre as mensagens que o cliente mandou desde a última fala do robô.
 * Mensagens seguidas chegam juntas no histórico ("Lorena\nSim sim"); vale a
 * primeira linha que parece nome.
 */
function nomeDaRajada(mensagens: any[], textoAtual: string): string | null {
  const ultima = mensagens[mensagens.length - 1]
  const bloco = ultima?.role === "user" ? String(ultima.content ?? "") : ""
  const linhas = [...bloco.split("\n"), textoAtual].map(l => l.trim()).filter(Boolean)
  return linhas.find(pareceNomeDePessoa) ?? null
}

function pareceNomeDeBairro(txt: string): boolean {
  const t = String(txt ?? "").trim()
  if (t.length < 3 || t.length > 40) return false
  if (NAO_E_BAIRRO.test(t)) return false
  if (PREFIXO_RUA.test(t)) return false          // isso é rua, não bairro
  if (t.includes("?")) return false              // pergunta não é endereço
  // Bairro é nome: letras, espaço e no máximo um número no fim ("Panatis 1").
  return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s.'-]{1,36}( ?\d{1,2})?$/.test(t)
}

async function handleSalvarBairro(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  bairro: string,
): Promise<void> {
  await salvarEnderecoNoCarrinho(empresaId, phone, { endereco_bairro: bairro })
  console.log(`[Bairro] salvo em mensagem separada: "${bairro}"`)
}

// ── handleSalvarNumero ───────────────────────────────────────────────────────
async function handleSalvarNumero(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  phoneLocal: string,
  numero: string,
  aceitaDelivery: boolean,
  pgtoOpcoes = "*dinheiro* ou *cartão*"
): Promise<{ resposta: string }> {
  try {
    const { data: c } = await supabase
      .from("whatsapp_carrinho")
      .select("endereco_rua, endereco_bairro, endereco_cidade, endereco_estado, endereco_lat, endereco_lng")
      .eq("empresa_id", empresaId)
      .eq("phone", phone)
      .single()

    if (!c?.endereco_rua) {
      return { resposta: "Não encontrei o endereço salvo. Me manda o *CEP* de novo — ou escreva o endereço. 😊" }
    }

    const { error: numErr } = await supabase.from("whatsapp_carrinho").update({
      endereco_numero: numero,
      updated_at:      new Date().toISOString(),
    }).eq("empresa_id", empresaId).eq("phone", phone)
    if (numErr) console.error("[Numero] update carrinho erro:", numErr)

    // Persiste endereço no cadastro do cliente para futuras sessões
    await supabase.from("clientes").update({
      endereco: c.endereco_rua,
      numero,
      bairro: c.endereco_bairro ?? null,
      cidade: c.endereco_cidade ?? null,
      estado: c.endereco_estado ?? null,
    }).eq("empresa_id", empresaId)
      .or(`telefone.eq.${phoneLocal},telefone.eq.${phone}`)

    // O ponto que ele mandou vira o pino do cadastro — AQUI, e não na hora da
    // localização, porque a chave que decide se o pino ainda vale é
    // rua+número+cidade (mig 0162). Sem o número ela não casaria com nada, e o
    // buscador de mapa voltaria a mandar no lugar dele.
    if (c.endereco_lat != null && c.endereco_lng != null) {
      const { data: ok, error: pinErr } = await supabase.rpc("salvar_pino_do_cliente", {
        p_empresa_id: empresaId,
        p_telefone:   phoneLocal,
        p_lat:        Number(c.endereco_lat),
        p_lng:        Number(c.endereco_lng),
      })
      if (pinErr) console.error("[Pino] rpc erro:", pinErr.message)
      else console.log(`[Pino] ponto do cliente salvo no cadastro: ${ok}`)
    }

    const localidade = [c.endereco_bairro, c.endereco_cidade, c.endereco_estado].filter(Boolean).join(" — ")
    const proximaPergunta = aceitaDelivery
      ? `Prefere *entrega* 🚚 ou vai *retirar* na loja? 🏪`
      : `Como vai pagar: ${pgtoOpcoes}? 💳`

    // Endereço ESCRITO não tem ponto: o entregador depende do mapa achar o
    // número, e rua nova/sem número oficial cai longe. O link deixa o próprio
    // cliente pôr o pino na porta. Quem mandou a localização já tem o ponto.
    let blocoPino = ""
    if (aceitaDelivery && (c.endereco_lat == null || c.endereco_lng == null)) {
      const { data: pin, error: pinErr } = await supabase.rpc("criar_pin_link_para", {
        p_empresa_id: empresaId, p_telefone: phone,
        p_rua: c.endereco_rua, p_numero: numero,
        p_bairro: c.endereco_bairro ?? null, p_cidade: c.endereco_cidade ?? null,
        p_estado: c.endereco_estado ?? null, p_cep: null,
        p_lat: null, p_lng: null, p_pedido_id: null,
      })
      if (pinErr) console.error("[Mapa] criar_pin_link_para erro:", pinErr.message)
      else if (pin?.ok) {
        blocoPino = `\n\n📌 Pra entrega cair certinho na sua porta, confere o ponto no mapa:\n👉 https://lojaonline.fwcinter.com/local/${pin.token}\n_Se estiver em casa agora, toque em *usar minha localização* — fica exato. Se não estiver, arraste o pino._`
      }
    }
    return {
      resposta: `✅ Endereço salvo!\n\n📍 *${c.endereco_rua}, ${numero}*\n${localidade}${blocoPino}\n\n${proximaPergunta}`
    }
  } catch (e: any) {
    console.error("[Numero] exceção:", e?.message ?? String(e))
    return { resposta: "Não consegui salvar o número. Pode repetir?" }
  }
}

// Decide entrega/retirada pela CONVERSA (o modelo às vezes erra o tipo no fechar,
// ex.: cliente disse "Retirar na loja" mas gravou entrega). O resumo do bot é
// autoritativo ("Retirada em" / "Entrega em"); senão, a última escolha clara do
// cliente. "retir" cobre "retirar" E "retirada". Retorna null se não der pra saber.
function tipoEntregaDaConversa(mensagens: any[]): "entrega" | "retirada" | null {
  const ultimaBot = (mensagens.filter((m: any) => m.role === "assistant").pop()?.content ?? "").toLowerCase()
  if (/retirada em|retire em|retirar em|vai retirar/.test(ultimaBot)) return "retirada"
  if (/entrega em|taxa de entrega|vou entregar/.test(ultimaBot)) return "entrega"
  const userMsgs = mensagens.filter((m: any) => m.role === "user").map((m: any) => (m.content ?? "").toLowerCase())
  for (let i = userMsgs.length - 1; i >= 0; i--) {
    const c = userMsgs[i]
    if (RE_RETIRADA.test(c)) return "retirada"
    if (/\bentreg|em casa|delivery/.test(c)) return "entrega"
  }
  return null
}

// ── Catálogo que cabe no prompt ──────────────────────────────────────────────
// Loja pequena manda o cardápio inteiro pro modelo e ele escolhe. Depósito com
// 4 mil itens não: colar tudo dá ~107 mil tokens POR MENSAGEM (uns R$ 0,50 e
// vários segundos), e o limite de 300 que existia aqui era pior ainda — o
// modelo enxergava de "29 CACHAÇA" até a letra B e jurava, educadíssimo, que a
// loja não tinha cerveja.
//
// Acima do teto o sistema PROCURA: pega as palavras do que o cliente vem
// falando e manda só o que casou, mais o que já está no carrinho (senão o
// modelo perde de vista o item que ele mesmo adicionou três mensagens atrás).
// Quanto o robô espera por mais mensagens antes de responder. Quem manda o
// pedido picado leva uns 2-4 s entre uma e outra; mais que isso atrasa quem
// manda tudo numa mensagem só.
//
// 4 s eram somados a TODA resposta, e a conta inteira ficava em 9-14 s — lento
// na cara de quem está esperando (teste 25/09). Em 2,5 s a proteção continua
// de pé (quem digita em rajada emenda mais rápido que isso) e some um segundo
// e meio de cada resposta. Se voltar a sair resposta repetida pro mesmo
// cliente, este é o número pra subir.
const ESPERA_RAJADA_MS = 2500

const MENU_INTEIRO_ATE = 300      // itens: abaixo disso, vai tudo
const MENU_BUSCA_MAX   = 80       // itens que a busca pode mandar

// ── Preço por quantidade (atacado) e promoção ────────────────────────────────
// A CDBom vende "picolé R$ 4,00, a partir de 10 sai a R$ 2,50". A Loja Online e
// a tela de Vender já cobravam assim; o robô não lia `faixas_preco` nem
// `preco_promocional` — quem pedia 10 picolés pagava R$ 40 em vez de R$ 25, e o
// combo de R$ 30 saía a R$ 50. Mesma conta de src/lib/precoQuantidade.js.
const PRODUTO_COLUNAS = "id, nome, preco_venda, preco_promocional, faixas_preco, embalagem, categoria, descricao"

function faixasOrdenadas(faixas: any): { qtd_min: number; preco: number }[] {
  return (Array.isArray(faixas) ? faixas : [])
    .map((f: any) => ({ qtd_min: Number(f?.qtd_min) || 0, preco: Number(f?.preco) || 0 }))
    .filter(f => f.qtd_min > 1 && f.preco > 0)
    .sort((a, b) => b.qtd_min - a.qtd_min)
}

/** Preço unitário do produto para essa quantidade: vale o MENOR que couber. */
function precoPorQuantidade(prod: any, qtd: number): number {
  const base = Number(prod?.preco_venda) || 0
  const faixa = faixasOrdenadas(prod?.faixas_preco).find(f => qtd >= f.qtd_min)
  const promo = Number(prod?.preco_promocional) || 0
  let preco = base
  if (promo > 0 && promo < preco) preco = promo
  if (faixa && faixa.preco < preco) preco = faixa.preco
  return preco
}

/**
 * Refaz o preço de cada item pela verdade do banco. A faixa conta a SOMA do
 * produto no carrinho: "5 de morango e 5 de chocolate" são duas linhas do mesmo
 * picolé, e juntas batem os 10 da faixa — igual à montagem da Loja Online.
 * Item cujo produto não está no catálogo fica como veio.
 */
// ── SABOR QUE A LOJA NÃO TEM ─────────────────────────────────────────────────
// A IA gravava na sacola o sabor que quisesse. Na CDBom (14/09/2026), num pedido
// grande de revenda, "Cremosinho uva, morango e leite condensado" virou 3x
// "Chiclete + Banana" no Picolé Cremoso, "Moreninha chocolate" virou leite
// condensado e "azul" entrou como sabor de um picolé que não tem azul — e a
// conferência saiu assim pro cliente. O roteiro já mandava não fazer isso; o
// Haiku não obedeceu. Agora o código confere: só passa sabor que existe no
// produto e não está pausado. Qualquer um fora disso, nada é gravado e o robô
// pergunta ao cliente.
type SaboresPorProduto = Record<string, { disponiveis: string[]; pausadas: string[] }>

const normSabor = (s: unknown) => String(s ?? "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/\bcom\b|\+|&/g, " ").replace(/[^a-z0-9]+/g, " ").trim()

const RE_MISTURADO = /^(misturad[oa]s?|sortid[oa]s?|variad[oa]s?|mix|sabores? variados?|a loja escolhe)$/
// "Misturado menos paçoca" (CDBom, 15/09/2026): 20 picolés de cobertura em
// todos os sabores tirando um. A IA manda {"nome": "Misturado", "exceto":
// ["Paçoca"]}, ou escreve tudo no nome — aqui separa as duas partes.
const RE_MISTURADO_EXCETO = /^(misturad[oa]s?|sortid[oa]s?|variad[oa]s?|mix|sabores? variados?|a loja escolhe|todos( os sabores)?)\s+(menos|sem|tirando|exceto|fora)\s+(.+)$/

/** Nome do sabor "Misturado" e a lista de sabores que o cliente não quer. */
function lerMisturado(c: any): { misturado: boolean; exceto: string[] } {
  const alvo = normSabor(c?.nome)
  const exceto = (Array.isArray(c?.exceto) ? c.exceto : []).map(normSabor).filter(Boolean)
  if (RE_MISTURADO.test(alvo)) return { misturado: true, exceto }
  const m = alvo.match(RE_MISTURADO_EXCETO)
  if (!m) return { misturado: false, exceto: [] }
  const doNome = m[4].replace(/\bde\b|\bo\b|\ba\b|\bos\b|\bas\b/g, " ").split(/\s+e\s+|\s+ou\s+/).map(normSabor).filter(Boolean)
  return { misturado: true, exceto: [...exceto, ...doNome] }
}

// ── SABOR QUE MUDA CONFORME O TAMANHO ────────────────────────────────────────
// CDBom, 14/09/2026: "quais são os sabores dos sorvetes?" e o robô listou os 15
// sabores do balde e da caixa. O pote de 200 ml só tem 3. Quando o mesmo
// produto vem em vários tamanhos com sabores diferentes, a pergunta certa é
// "qual tamanho?" antes de qualquer lista.
type FamiliaTamanho = {
  nome: string                  // "Sorvete CDBOM"
  chave: string                 // "sorvete" — a palavra que o cliente usa
  marcas: Set<string>           // palavras que já dizem o tamanho ("pote", "200", "balde")
  tamanhos: { rotulo: string; preco: number; sabores: string[] }[]
}

const baseDoNome = (nome: string) => String(nome ?? "").replace(/\([^)]*\)/g, " ").replace(/\s-\s.*$/, "").replace(/\s+/g, " ").trim()
const rotuloDoTamanho = (nome: string) => {
  const dentro = (String(nome).match(/\(([^)]*)\)/) ?? [])[1] ?? ""
  const depois = (String(nome).match(/\)\s*-\s*(.+)$/) ?? [])[1] ?? ""
  return [dentro, depois].filter(Boolean).join(" - ").trim()
}

function familiasPorTamanho(produtos: any[], sabores: SaboresPorProduto): FamiliaTamanho[] {
  const grupos = new Map<string, any[]>()
  for (const p of produtos) {
    if (!sabores[p.id]?.disponiveis?.length || !rotuloDoTamanho(p.nome)) continue
    const k = normSabor(baseDoNome(p.nome))
    if (k) (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(p)
  }
  const familias: FamiliaTamanho[] = []
  for (const [k, lista] of grupos) {
    if (lista.length < 2) continue
    const assinaturas = new Set(lista.map(p => sabores[p.id].disponiveis.map(normSabor).sort().join("|")))
    if (assinaturas.size < 2) continue // todos os tamanhos têm os mesmos sabores: lista única serve
    const marcas = new Set<string>()
    for (const p of lista) {
      for (const w of normSabor(rotuloDoTamanho(p.nome)).split(" ")) if (w.length >= 2 || /\d/.test(w)) marcas.add(w)
    }
    ["litro", "litros", "lt", "l", "ml"].forEach(w => marcas.delete(w)) // "litro" sozinho não escolhe entre 10 e 5
    familias.push({
      nome: baseDoNome(lista[0].nome),
      chave: k.split(" ")[0],
      marcas,
      tamanhos: lista.map(p => {
        const promo = Number(p.preco_promocional)
        return {
          rotulo: rotuloDoTamanho(p.nome),
          preco: promo > 0 && promo < Number(p.preco_venda) ? promo : Number(p.preco_venda),
          sabores: sabores[p.id].disponiveis,
        }
      }).sort((a, b) => b.preco - a.preco),
    })
  }
  return familias
}

/** Perguntou os sabores de um produto que muda por tamanho, sem dizer o tamanho? */
function saborSemTamanho(texto: string, familias: FamiliaTamanho[]): FamiliaTamanho | null {
  const t = normSabor(texto)
  if (!/\bsabor/.test(t)) return null
  const palavras = new Set(t.split(" "))
  for (const f of familias) {
    const falouDoProduto = palavras.has(f.chave) || palavras.has(`${f.chave}s`) || palavras.has(f.chave.replace(/s$/, ""))
    if (!falouDoProduto) continue
    if ([...f.marcas].some(m => palavras.has(m))) return null
    return f
  }
  return null
}

/**
 * "Misturado": divide a quantidade igualmente entre os sabores DISPONÍVEIS do
 * produto (pedido da loja, 14/09/2026). 40 misturado com Coco, Uva e Morango
 * vira 14 Coco + 13 Uva + 13 Morango. Menos unidades que sabores: 1 de cada
 * até acabar. No fim junta linhas repetidas do mesmo sabor ("10 Coco + o resto
 * misturado" não aparece com Coco duas vezes).
 */
function distribuirMisturado(itens: any[], sabores: SaboresPorProduto): any[] {
  const saida: any[] = []
  // Sabores que o cliente já escolheu, por produto: "10 de coco e o resto
  // misturado" manda o resto pros OUTROS sabores, não mais coco.
  const escolhidos = new Map<string, Set<string>>()
  for (const it of itens ?? []) {
    const comps = Array.isArray(it?.complementos) ? it.complementos : []
    if (comps.length === 1 && !lerMisturado(comps[0]).misturado) {
      const k = String(it?.produto_id ?? "")
      if (!escolhidos.has(k)) escolhidos.set(k, new Set())
      escolhidos.get(k)!.add(normSabor(comps[0]?.nome))
    }
  }
  for (const it of itens ?? []) {
    const comps = Array.isArray(it?.complementos) ? it.complementos : []
    const sp = sabores[String(it?.produto_id ?? "")]
    const mist = comps.length === 1 ? lerMisturado(comps[0]) : { misturado: false, exceto: [] as string[] }
    // "Menos paçoca": tira o sabor que casar pelo nome ("paçoca" tira "Paçoca"
    // e "Paçoca + Nata"). Sabor que o produto nem tem não muda nada.
    const naoQuer = (n: string) => mist.exceto.some(x => new RegExp(`\\b${x}\\b`).test(normSabor(n)))
    const todas = (sp?.disponiveis ?? []).filter(n => !/^\s*sem\s|n[ãa]o\s*quero/i.test(n) && !naoQuer(n))
    const jaTem = escolhidos.get(String(it?.produto_id ?? "")) ?? new Set<string>()
    const outras = todas.filter(n => !jaTem.has(normSabor(n)))
    const opcoes = outras.length ? outras : todas
    if (!mist.misturado) { saida.push(it); continue }
    // Nada sobrou pra misturar: vai sem sabor, e a loja escolhe.
    if (!opcoes.length) { saida.push({ ...it, complementos: [] }); continue }
    const qtd = Math.max(0, Math.floor(Number(it.qtd) || 0))
    const base = Math.floor(qtd / opcoes.length)
    let resto = qtd - base * opcoes.length
    const { exceto: _exceto, ...compBase } = comps[0] ?? {}
    for (const sabor of opcoes) {
      const q = base + (resto > 0 ? 1 : 0)
      if (resto > 0) resto--
      if (q > 0) saida.push({ ...it, qtd: q, complementos: [{ ...compBase, nome: sabor }] })
    }
  }
  // Junta mesmo produto + mesmo sabor único.
  const juntos: any[] = []
  for (const it of saida) {
    const comps = Array.isArray(it?.complementos) ? it.complementos : []
    const igual = comps.length === 1 && juntos.find(j =>
      String(j.produto_id) === String(it.produto_id) && Array.isArray(j.complementos) && j.complementos.length === 1
      && normSabor(j.complementos[0]?.nome) === normSabor(comps[0]?.nome))
    if (igual) igual.qtd = (Number(igual.qtd) || 0) + (Number(it.qtd) || 0)
    else juntos.push({ ...it })
  }
  return juntos
}

/**
 * Confere (e acerta a grafia de) cada sabor dos itens. Devolve a mensagem pro
 * cliente quando algum não vale, ou null quando está tudo certo.
 */
function conferirSabores(
  itens: any[], sabores: SaboresPorProduto, catalogo: any[],
  contexto: { fala?: string; jaPerguntou?: boolean } = {},
): string | null {
  const falaCliente = normSabor(contexto.fala ?? "")
  const problemas = new Map<string, { produto: string; faltam: Set<string>; acabaram: Set<string>; duvidas: Set<string>; tem: string[] }>()
  for (const it of itens ?? []) {
    const sp = sabores[String(it?.produto_id ?? "")]
    if (!sp || !Array.isArray(it?.complementos)) continue
    for (const c of it.complementos) {
      const alvo = normSabor(c?.nome)
      if (!alvo) continue
      // "Misturado/sortido/variado": a loja escolhe os sabores (CDBom, 14/09).
      // Com um sabor só disponível, "misturado" é esse sabor.
      if (lerMisturado(c).misturado) {
        delete c.exceto
        c.nome = sp.disponiveis.length === 1 ? sp.disponiveis[0] : "Misturado"
        continue
      }
      // Por qual palavra a lista de dúvida vai ser cortada, e como ela é
      // apresentada. Muda quando quem gerou a dúvida foi o apelido que o
      // cliente usou ("calabresa"), e não o nome que o modelo escreveu.
      let baseCorte = alvo
      let rotuloDuvida = String(c?.nome ?? "").trim()
      let achado = sp.disponiveis.find(n => normSabor(n) === alvo)
      // Só aceita parecido quando o cliente escreveu MAIS que o nome ("sabor
      // morango" → Morango) e há um único candidato. O contrário ("uva" →
      // "Nata + Uva") é exatamente a troca que não pode acontecer.
      if (!achado) {
        const parecidos = sp.disponiveis.filter(n => {
          const k = normSabor(n)
          return k.length >= 3 && new RegExp(`\\b${k}\\b`).test(alvo)
        })
        if (parecidos.length === 1) achado = parecidos[0]
      }
      // Sem o sufixo do bloco: "Calabresa Acebolada" é "Calabresa Acebolada
      // (Promoção)" na pizza meio a meio da Marajó. Se o mesmo nome existe em
      // dois blocos ("3 Queijos (Promoção)" R$ 34,99 e "(Especiais)" R$ 40), o
      // preço muda — aí pergunta, não escolhe.
      const semSufixo = (n: string) => normSabor(String(n).replace(/\s*\([^()]*\)\s*$/, ""))
      let emDois: string[] = []
      if (!achado) {
        const curtos = sp.disponiveis.filter(n => semSufixo(n) === alvo)
        if (curtos.length === 1) achado = curtos[0]
        else if (curtos.length > 1) emDois = curtos
      }
      // FAMÍLIA DE SABOR: "calabresa" numa casa que tem Calabresa Acebolada,
      // Calabresa com Cheddar, Calabresa com Catupiry e Calabresa com Requeijão.
      //
      // Nenhum sabor se chama só "Calabresa", então nada acima casava e o
      // cliente ouvia "não temos esse sabor" — de uma pizzaria com quatro
      // calabresas no cardápio. É o jeito mais rápido de perder o pedido.
      // Um candidato só: é ele. Vários: pergunta qual, que é o que o atendente
      // de balcão faz.
      if (!achado && emDois.length === 0 && alvo.length >= 3) {
        const escapado = alvo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const daFamilia = sp.disponiveis.filter(n => new RegExp(`\\b${escapado}\\b`).test(normSabor(n)))
        if (daFamilia.length === 1) achado = daFamilia[0]
        else if (daFamilia.length > 1) emDois = daFamilia
      }
      if (achado) {
        // O MODELO ESCOLHEU A CALABRESA NO LUGAR DO CLIENTE.
        //
        // Ele pediu "meia calabresa" numa casa com quatro calabresas, e o
        // modelo mandou a Acebolada (a primeira da lista) sem perguntar. Fica
        // R$ 4,00 mais barato que a de Catupiry e, pior, pode ser a pizza
        // errada. O atendente de balcão pergunta — aqui também.
        //
        // Só vale quando o cliente NÃO escreveu o nome inteiro: se ele disse
        // "calabresa com catupiry", a escolha é dele e passa direto. E pergunta
        // uma vez só, senão vira roda-viva.
        const normAchado = normSabor(achado)
        if (!contexto.jaPerguntou && falaCliente && !falaCliente.includes(normAchado)) {
          const apelido = normAchado.split(" ")
            .find(w => w.length >= 4 && new RegExp(`\\b${w}\\b`).test(falaCliente))
          if (apelido) {
            const primos = sp.disponiveis.filter(n => new RegExp(`\\b${apelido}\\b`).test(normSabor(n)))
            if (primos.length > 1) {
              emDois = primos
              achado = undefined
              baseCorte = apelido
              rotuloDuvida = apelido.charAt(0).toUpperCase() + apelido.slice(1)
            }
          }
        }
      }
      if (achado) { c.nome = achado; continue }
      const nomeProduto = String(catalogo.find((p: any) => p.id === it.produto_id)?.nome ?? it.nome ?? "produto")
      const p = problemas.get(it.produto_id) ?? { produto: nomeProduto, faltam: new Set(), acabaram: new Set(), duvidas: new Set(), tem: sp.disponiveis }
      const pausado = sp.pausadas.find(n => normSabor(n) === alvo || semSufixo(n) === alvo)
      if (emDois.length) {
        // "3 Queijos: Promoção ou Especiais" quando a diferença é o bloco; e
        // "Calabresa: Acebolada, com Cheddar ou com Catupiry" quando a
        // diferença é o resto do nome — repetir "Calabresa" em cada item da
        // lista só faz o cliente ler quatro vezes a mesma palavra.
        //
        // O corte do prefixo compara PALAVRA POR PALAVRA já normalizada, e não
        // por tamanho: normSabor come o "com" e os acentos, então "Calabresa
        // com Cheddar" tem 21 letras cruas e 19 normalizadas — cortar pelo
        // número de letras comeria pedaço do nome.
        const palavrasAlvo = baseCorte.split(" ").filter(Boolean)
        const blocos = emDois.map(n => {
          const sufixo = String(n).match(/\(([^()]*)\)\s*$/)?.[1]
          if (sufixo) return sufixo.trim()
          const cru = String(n).trim()
          const brutas = cru.split(/\s+/)
          let i = 0, j = 0
          while (i < brutas.length && j < palavrasAlvo.length) {
            const p = normSabor(brutas[i])
            if (!p) { i++; continue }              // "com" some no normSabor
            if (p !== palavrasAlvo[j]) break
            i++; j++
          }
          if (j < palavrasAlvo.length) return cru  // não era prefixo: nome inteiro
          return brutas.slice(i).join(" ").trim() || cru
        })
        p.duvidas.add(`${rotuloDuvida}: ${blocos.slice(0, -1).join(", ")} ou ${blocos[blocos.length - 1]}`)
      }
      else if (pausado) p.acabaram.add(pausado)
      else p.faltam.add(String(c?.nome ?? "").trim())
      problemas.set(it.produto_id, p)
    }
  }
  if (!problemas.size) return null
  const linhas = [...problemas.values()].map(p => {
    // Só dúvida de qual versão do sabor: pergunta sem despejar a lista inteira.
    if (p.duvidas.size && !p.acabaram.size && !p.faltam.size) {
      return `• *${p.produto}*: qual você quer — ${[...p.duvidas].join("; ")}?`
    }
    const partes: string[] = []
    if (p.duvidas.size) partes.push(`preciso saber qual: ${[...p.duvidas].join("; ")}`)
    if (p.acabaram.size) partes.push(`*${[...p.acabaram].join(", ")}* acabou no momento`)
    if (p.faltam.size) partes.push(`não tem *${[...p.faltam].join(", ")}*`)
    const tem = p.tem.length ? ` Sabores que tem: ${p.tem.join(", ")}.` : ""
    return `• *${p.produto}*: ${partes.join(" e ")}.${tem}`
  })
  const soDuvida = [...problemas.values()].every(p => !p.acabaram.size && !p.faltam.size)
  return soDuvida
    ? `Só pra eu anotar certinho: 😊\n\n${linhas.join("\n")}`
    : `Antes de anotar, preciso acertar uns sabores: 😊\n\n${linhas.join("\n")}\n\nQual você prefere no lugar? Aí eu anoto o pedido todo.`
}

// Opção de complemento → de qual grupo ela é e se o grupo cobra pelo maior.
type RegrasOpcao = Record<string, Record<string, { grupo: string; maior: boolean; preco: number }>>

/**
 * Quanto os complementos de UM item somam, com a regra de cada grupo — a mesma
 * conta de src/lib/complementos.js (adicionalComplementos). Pizza meio a meio
 * ("Escolha 2 sabores", regra 'maior'): meia Promoção R$ 34,99 + meia Especial
 * R$ 45 = R$ 45, não R$ 79,99. A borda, que soma, entra por cima.
 */
function adicionalDoItem(it: any, precoOpcaoMap: Record<string, number>, regras: RegrasOpcao): number {
  const doProduto = regras[String(it?.produto_id ?? "")] ?? {}
  const maiorPorGrupo = new Map<string, number>()
  let soma = 0
  for (const c of (Array.isArray(it?.complementos) ? it.complementos : [])) {
    const nome = String(c?.nome ?? "").trim().toLowerCase()
    const r = doProduto[nome]
    if (r?.maior) {
      maiorPorGrupo.set(r.grupo, Math.max(maiorPorGrupo.get(r.grupo) ?? 0, r.preco))
      continue
    }
    const add = r ? r.preco : precoOpcaoMap[nome]
    if (add) soma += add * Number(c?.qtd ?? 1)
  }
  for (const v of maiorPorGrupo.values()) soma += v
  return soma
}

// ── ESCOLHA OBRIGATÓRIA (mig 0120 + min/max do grupo) ────────────────────────
// A pizza da Marajó tem "Borda (escolha 1)" — obrigatória, e "Sem borda" é uma
// das opções — e "Escolha 2 sabores" (exatamente 2). A IA anotava sem borda
// nenhuma, e a cozinha recebia a pizza sem saber o que fazer na beirada.
//
// Só vale pro grupo em que a escolha MUDA O PREÇO. O sabor do picolé da CDBom
// também é "escolha 1", mas é de graça e a loja manda sortido quando o cliente
// não escolhe — exigir ali quebraria o fluxo dela (roteiro de 15/09/2026).
type Exigencias = Record<string, { nome: string; min: number; max: number; opcoes: string[] }[]>

// Começo da fala da rede. Serve de marca: no turno seguinte é por ele que o
// código reconhece que existe um item pendurado esperando a escolha.
const AVISO_ESCOLHA_PREFIXO = "Falta só isso pra eu anotar"

// "Sem borda", "Não quero recheio": a opção que serve pra RECUSAR a categoria.
const ehOptOut = (nome: string) => /^\s*sem\s|n[ãa]o\s*quero/i.test(String(nome || ""))

/**
 * O MODELO ESCOLHEU O PRODUTO NO LUGAR DO CLIENTE.
 *
 * Irmã da checagem que existe pros SABORES (conferirSabores), mas pro nome do
 * PRODUTO — e foi por aí que escapou: "uma pizza de carne de sol e uma de
 * calabresa" virou "Carne de Sol com Queijo Coalho" e "Calabresa Acebolada"
 * sem ninguém perguntar nada (25/09). Meio a meio passa por complemento e
 * estava coberto; pizza inteira é produto e não estava.
 *
 * Vale quando o cliente usou um apelido que serve pra MAIS DE UM produto do
 * cardápio e não escreveu o nome inteiro. Item que já estava na sacola não
 * entra: aquele já foi combinado, e `atualizar_carrinho` reenvia a sacola toda.
 */
function conferirProdutoAmbiguo(
  itens: any[], catalogo: any[], jaNaSacola: any[],
  contexto: { fala?: string; jaPerguntou?: boolean } = {},
): string | null {
  if (contexto.jaPerguntou) return null
  const fala = normSabor(contexto.fala ?? "")
  if (!fala) return null
  const linhas: string[] = []
  const vistos = new Set<string>()
  for (const it of itens ?? []) {
    const pid = String(it?.produto_id ?? "")
    if (!pid || vistos.has(pid)) continue
    if ((jaNaSacola ?? []).some((c: any) => String(c?.produto_id ?? "") === pid)) continue
    const prod = catalogo.find((p: any) => p.id === pid)
    if (!prod) continue
    const norm = normSabor(prod.nome)
    // Nome inteiro na fala do cliente: a escolha é dele, passa.
    if (!norm || fala.includes(norm)) continue
    const apelido = norm.split(" ").find(w => w.length >= 4 && new RegExp(`\\b${w}\\b`).test(fala))
    if (!apelido) continue
    const primos = catalogo.filter((p: any) => new RegExp(`\\b${apelido}\\b`).test(normSabor(p.nome)))
    if (primos.length < 2) continue
    vistos.add(pid)
    // O rótulo é o começo que TODOS os candidatos têm em comum, não a palavra
    // solta que casou: "carne" acha os dois, mas quem lê quer ver "Carne de
    // Sol". Se não houver começo comum, fica o apelido mesmo.
    const palavrasDe = (p: any) => String(p?.nome ?? "").trim().split(/\s+/)
    const base = palavrasDe(primos[0])
    let comuns = 0
    while (comuns < base.length
      && primos.every((p: any) => normSabor(palavrasDe(p)[comuns] ?? "") === normSabor(base[comuns]))) comuns++
    // "Carne de Sol com Catupiry" e "...com Queijo Coalho" compartilham até o
    // "com" — e "Carne de Sol com — qual delas?" fica pela metade. Palavrinha
    // de ligação no fim do rótulo sai fora.
    while (comuns > 0 && /^(com|de|da|do|e|no|na|ao|em)$/i.test(base[comuns - 1])) comuns--
    const rotulo = comuns > 0
      ? base.slice(0, comuns).join(" ")
      : apelido.charAt(0).toUpperCase() + apelido.slice(1)
    linhas.push(`• *${rotulo}* — qual delas?\n${primos.map((p: any) =>
      `  • ${p.nome} — R$ ${Number(p.preco_venda ?? 0).toFixed(2).replace(".", ",")}`).join("\n")}`)
  }
  if (!linhas.length) return null
  return `${AVISO_ESCOLHA_PREFIXO}: 😊\n\n${linhas.join("\n\n")}`
}

function conferirEscolhas(
  itens: any[], exigencias: Exigencias, catalogo: any[],
  // O que o cliente escreveu nas últimas mensagens, e se o robô JÁ cobrou a
  // escolha uma vez (aí não cobra de novo — ver o bloco do opt-out).
  contexto: { fala?: string; jaPerguntou?: boolean } = {},
): string | null {
  const dito = normSabor(contexto.fala ?? "")
  const linhas: string[] = []
  for (const it of itens ?? []) {
    const grupos = exigencias[String(it?.produto_id ?? "")]
    if (!grupos?.length) continue
    const escolhidos = (Array.isArray(it?.complementos) ? it.complementos : [])
      .map((c: any) => normSabor(c?.nome))
    const nomeProduto = String(catalogo.find((p: any) => p.id === it.produto_id)?.nome ?? it.nome ?? "produto")
    // O QUE JÁ FOI ESCOLHIDO VAI NA MENSAGEM.
    //
    // Esta fala SUBSTITUI a do modelo, e o que fica gravado na conversa é ela.
    // Sem os sabores aqui, no turno seguinte o modelo lê só "Pizza 2 Sabores —
    // falta a borda": ele não sabe mais QUAL pizza era, responde "Perfeito!" e
    // não reemite o item — a pizza some da sacola (testado 25/09 com meia
    // calabresa/meia carne de sol). Com os sabores escritos, ele relê a própria
    // pendência e monta o item completo. O cliente também confere de graça.
    // O "Sem borda" fica de fora: dizer "(Calabresa, Sem borda) — falta
    // escolher a Borda" é uma contradição na cara do cliente.
    const jaEscolhido = (Array.isArray(it?.complementos) ? it.complementos : [])
      .map((c: any) => String(c?.nome ?? "").trim())
      .filter((n: string) => n && !ehOptOut(n)).join(", ")
    const oQueTem = jaEscolhido ? ` (${jaEscolhido})` : ""
    for (const g of grupos) {
      const doGrupo = g.opcoes.filter(o => escolhidos.includes(normSabor(o))).length
      if (g.min > 0 && doGrupo < g.min) {
        const quantos = g.min === 1 ? "" : ` (são ${g.min})`
        linhas.push(`• *${nomeProduto}*${oQueTem} — falta escolher: *${g.nome}*${quantos}\n${g.opcoes.map(o => `  • ${o}`).join("\n")}`)
      } else if (g.max > 0 && doGrupo > g.max) {
        linhas.push(`• *${nomeProduto}*${oQueTem} — em *${g.nome}* dá pra escolher ${g.max === 1 ? "só 1" : `${g.max}`}, e vieram ${doGrupo}. Quais ficam?`)
      } else if (g.min > 0 && !contexto.jaPerguntou) {
        // ELE ESCOLHEU "SEM BORDA" NO LUGAR DO CLIENTE.
        //
        // O modelo fecha o item marcando a opção de recusa quando o cliente não
        // falou nada — e o min/max fica satisfeito, então nada aqui reclamava.
        // Na prática é a loja perdendo a borda de R$ 8,00 numa pergunta que
        // nunca foi feita (pizza de calabresa + mussarela, 25/09).
        //
        // Só vale quando o cliente REALMENTE não tocou no assunto: se ele falou
        // "borda" ou citou qualquer opção, a escolha é dele e passa. E cobra
        // uma vez só — se o robô já perguntou e ele desconversou, segue o jogo.
        const doGrupoNomes = g.opcoes.filter(o => escolhidos.includes(normSabor(o)))
        const soRecusa = doGrupoNomes.length > 0 && doGrupoNomes.every(o => ehOptOut(o))
        const clienteTocouNoAssunto = !!dito && (
          dito.includes(normSabor(g.nome))
          || g.opcoes.some(o => !ehOptOut(o) && dito.includes(normSabor(o)))
        )
        if (soRecusa && !clienteTocouNoAssunto) {
          linhas.push(`• *${nomeProduto}*${oQueTem} — falta escolher: *${g.nome}*\n${g.opcoes.map(o => `  • ${o}`).join("\n")}`)
        }
      }
    }
  }
  if (!linhas.length) return null
  return `${AVISO_ESCOLHA_PREFIXO}: 😊\n\n${linhas.join("\n\n")}`
}

/**
 * Id do produto que não combina com as ESCOLHAS do item. Na recuperação da
 * sacola (2ª chamada) a IA mandou a meia a meia com o id da pizza inteira de
 * Calabresa: os sabores não existem nela, a conferência barrava tudo e o robô
 * travou repetindo o aviso (teste Marajó, 16/09/2026). Se só UM produto do
 * cardápio tem todas aquelas escolhas, é ele. Roda antes de conferirSabores.
 */
function acertarProdutoPelasEscolhas(itens: any[], catalogo: any[], sabores: SaboresPorProduto): void {
  const semSufixo = (n: string) => normSabor(String(n).replace(/\s*\([^()]*\)\s*$/, ""))
  const temTudo = (pid: string, comps: string[]) => {
    const sp = sabores[pid]
    if (!sp) return false
    const todas = [...sp.disponiveis, ...sp.pausadas]
    const cheias = new Set(todas.map(normSabor))
    const curtas = new Set(todas.map(semSufixo))
    return comps.every(c => cheias.has(normSabor(c)) || curtas.has(normSabor(c)))
  }
  for (const it of itens ?? []) {
    const comps = (Array.isArray(it?.complementos) ? it.complementos : [])
      .map((c: any) => String(c?.nome ?? "").trim())
      .filter((n: string) => n && !lerMisturado({ nome: n }).misturado)
    if (!comps.length || temTudo(String(it?.produto_id ?? ""), comps)) continue
    const certos = (catalogo ?? []).filter((p: any) => temTudo(String(p.id), comps))
    if (certos.length !== 1) continue
    console.log(`[Item] id trocado pelas escolhas: "${it.nome}" → ${certos[0].nome}`)
    it.produto_id = certos[0].id
    it.nome = certos[0].nome
  }
}

function reprecificarItens(itens: any[], catalogo: any[], precoOpcaoMap: Record<string, number> = {}, regrasOpcao: RegrasOpcao = {}): void {
  const porId = new Map<string, any>()
  for (const p of catalogo ?? []) porId.set(String(p.id), p)
  // Nome e id que não batem: o modelo escreveu "Açaí CDBOM (Caixa 5 litros)"
  // com o id do SORVETE de 5 litros, e a sacola mostrou R$ 35 em vez de R$ 60
  // (teste 13/09). Se o nome é exatamente o de outro produto, vale o nome;
  // senão fica o id e o nome é corrigido pelo dele.
  const normNome = (s: any) => String(s ?? "").normalize("NFD").replace(RE_ACENTOS_PRECO, "").toLowerCase().replace(/\s+/g, " ").trim()
  for (const it of itens ?? []) {
    const peloId = porId.get(String(it?.produto_id ?? ""))
    if (!peloId || normNome(peloId.nome) === normNome(it.nome)) continue
    const peloNome = (catalogo ?? []).find((p: any) => normNome(p.nome) === normNome(it.nome))
    if (peloNome) {
      console.log(`[Item] id trocado pelo nome: "${it.nome}" (${peloId.nome} → ${peloNome.nome})`)
      it.produto_id = peloNome.id
    } else {
      it.nome = peloId.nome
    }
  }
  const qtdPorProduto: Record<string, number> = {}
  for (const it of itens ?? []) {
    const id = String(it?.produto_id ?? "")
    if (id) qtdPorProduto[id] = (qtdPorProduto[id] ?? 0) + (Number(it.qtd) || 0)
  }
  for (const it of itens ?? []) {
    const prod = porId.get(String(it?.produto_id ?? ""))
    if (!prod) continue
    const adicionais = adicionalDoItem(it, precoOpcaoMap, regrasOpcao)
    const novo = +(precoPorQuantidade(prod, qtdPorProduto[String(prod.id)]) + adicionais).toFixed(2)
    if (novo !== Number(it.preco)) console.log(`[Preço] corrigido ${it.nome}: ${it.preco} → ${novo}`)
    it.preco = novo
  }
}

/**
 * O que o cliente lê depois de pôr o item na sacola: o desconto que já pegou, ou
 * quanto falta pro próximo degrau quando está perto (7 de 10). Desconto que o
 * cliente não sabe que existe não vende nada.
 */
function avisoDeAtacado(itens: any[], catalogo: any[]): string {
  const rs = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`
  const qtdPorProduto = new Map<string, number>()
  for (const it of itens ?? []) {
    const id = String(it?.produto_id ?? "")
    if (id) qtdPorProduto.set(id, (qtdPorProduto.get(id) ?? 0) + (Number(it.qtd) || 0))
  }
  const linhas: string[] = []
  for (const [id, qtd] of qtdPorProduto) {
    const prod = (catalogo ?? []).find((p: any) => String(p.id) === id)
    const faixas = faixasOrdenadas(prod?.faixas_preco)
    if (!prod || !faixas.length) continue
    const aplicada = faixas.find(f => qtd >= f.qtd_min)
    const proxima = [...faixas].reverse().find(f => qtd < f.qtd_min)
    if (proxima && proxima.qtd_min - qtd <= Math.ceil(proxima.qtd_min / 2)) {
      const falta = proxima.qtd_min - qtd
      const comSabor = (itens ?? []).some((it: any) => String(it?.produto_id ?? "") === id && Array.isArray(it.complementos) && it.complementos.length > 0)
      linhas.push(`💡 *${prod.nome}*: com mais ${falta} (${proxima.qtd_min} no total${comSabor ? ", pode misturar os sabores" : ""}) sai a *${rs(proxima.preco)}* cada!`)
    } else if (aplicada && aplicada.preco < (Number(prod.preco_venda) || 0)) {
      linhas.push(`💰 *${prod.nome}*: levando ${qtd}, sai a *${rs(aplicada.preco)}* cada (preço de atacado).`)
    }
  }
  return linhas.join("\n")
}

/** As duas sacolas têm os mesmos itens, quantidades e escolhas? (preço não conta) */
function mesmoCarrinho(a: any[], b: any[]): boolean {
  const chave = (itens: any[]) => (itens ?? [])
    .map((i: any) => [
      String(i?.produto_id ?? i?.nome ?? ""), Number(i?.qtd) || 0,
      (Array.isArray(i?.complementos) ? i.complementos : []).map((c: any) => String(c?.nome ?? "").trim().toLowerCase()).sort().join("|"),
    ].join("#"))
    .sort().join(";")
  return chave(a) === chave(b)
}

/** Total da sacola, pra mostrar a cada item que entra. */
/**
 * A conferência da sacola, agrupada por produto:
 *
 *   🍽️ *Dunaszinho (Sorvete de Iogurte)* — 30 un · *R$ 60,00*
 *      • Uva — 10
 *      • Leite condensado — 10
 *
 * O robô grava uma linha por sabor (é o que o preço de atacado precisa), e a
 * mensagem saía repetindo o nome do produto em cada sabor — 13 blocos pra um
 * pedido de 4 produtos (CDBom, 14/09/2026). Aqui o nome aparece uma vez, com o
 * total de unidades e o valor; embaixo, cada sabor com a sua quantidade.
 */
function detalheDaSacola(itens: any[]): string {
  const rs = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`
  const grupos = new Map<string, { nome: string; qtd: number; valor: number; linhas: string[] }>()
  for (const it of itens ?? []) {
    const chave = String(it?.produto_id ?? it?.nome ?? "")
    const g = grupos.get(chave) ?? { nome: String(it?.nome ?? ""), qtd: 0, valor: 0, linhas: [] }
    const qtd = Number(it?.qtd) || 0
    g.qtd += qtd
    g.valor += qtd * (Number(it?.preco) || 0)
    const comps = (Array.isArray(it?.complementos) ? it.complementos : [])
      .map((c: any) => String(c?.nome ?? "").trim()).filter(Boolean)
    if (comps.length) g.linhas.push({ texto: comps.join(", "), qtd } as any)
    grupos.set(chave, g)
  }
  // O mínimo que o cliente precisa pra conferir: produto, quantidade, valor e
  // os sabores numa linha só. O nome vai inteiro: o que está entre parênteses
  // costuma ser o TAMANHO ("Quentinha (M)", "Sorvete (Pote 200 ml)").
  return [...grupos.values()].map(g => {
    const cab = `*${g.nome}* ${g.qtd} un — ${rs(g.valor)}`
    const itens = g.linhas as any[]
    if (!itens.length) return cab
    // Um sabor só pro produto todo (ou item montado): sem repetir a quantidade.
    const sabores = (itens.length === 1 && itens[0].qtd === g.qtd)
      ? itens[0].texto
      : itens.map(l => `${l.texto} ${l.qtd}`).join(" · ")
    return `${cab}\n${sabores}`
  }).join("\n\n")
}

function totalDaSacola(itens: any[]): number {
  return (itens ?? []).reduce((s: number, i: any) => s + (Number(i?.qtd) || 0) * (Number(i?.preco) || 0), 0)
}

/**
 * Troca, no resumo escrito pelo modelo, as linhas dos itens, a taxa e o total
 * pelos números da sacola. Endereço, pagamento e troco ficam como ele escreveu.
 * As linhas saem no formato "• Nome x2 — R$ 10.00", que é o que
 * extrairItensDoResumo sabe ler se o carrinho sumir.
 */
function corrigirResumo(texto: string, itens: any[], taxa: number): string {
  const linhas = texto.split("\n")
  const ini = linhas.findIndex(l => /resumo do pedido/i.test(l))
  if (ini === -1) return texto
  const ehItem = (l: string) => /^\s*[•●▪\-]\s+/.test(l) && /R\$/.test(l) && !/taxa|total|troco|entrega em|retirada em|pagamento/i.test(l)
  const primeiro = linhas.findIndex((l, i) => i > ini && ehItem(l))
  if (primeiro === -1) return texto
  let fim = primeiro
  // Até o último item do bloco (sub-linha de sabor "   • Coco" sem R$ também sai).
  for (let i = primeiro + 1; i < linhas.length; i++) {
    if (ehItem(linhas[i])) fim = i
    else if (/^\s+[•●▪\-]\s+/.test(linhas[i])) continue
    else break
  }

  const novas = itens.map((i: any) => {
    const comps = Array.isArray(i.complementos) && i.complementos.length ? ` (${i.complementos.map((c: any) => c.nome).join(", ")})` : ""
    return `• ${i.nome}${comps} x${Number(i.qtd) || 1} — R$ ${((Number(i.qtd) || 0) * (Number(i.preco) || 0)).toFixed(2)}`
  })
  const saida = [...linhas.slice(0, primeiro), ...novas, ...linhas.slice(fim + 1)]

  const temTaxa = saida.some(l => /taxa de entrega/i.test(l))
  const total = totalDaSacola(itens) + (temTaxa ? taxa : 0)
  return saida.map(l => {
    if (/taxa de entrega/i.test(l)) return l.replace(/R\$\s*[\d.,]+/, `R$ ${taxa.toFixed(2)}`)
    if (/total/i.test(l) && !/sacola/i.test(l)) return l.replace(/R\$\s*[\d.,]+/, `R$ ${total.toFixed(2)}`)
    return l
  }).join("\n")
}

/**
 * Cardápio do prompt separado por categoria. Em ordem alfabética, "Açaí CDBOM
 * (Balde 10 litros)" e "Sorvete CDBOM (Balde 10 litros)" ficavam com nome quase
 * igual e preços longe um do outro — o modelo mostrou o balde de SORVETE a
 * R$ 125, que é o preço do açaí (conversa real, 13/09). Com o título da
 * categoria em cima, cada preço fica perto do que ele é.
 */
function cardapioPorCategoria(produtos: any[]): string {
  const grupos = new Map<string, any[]>()
  for (const p of produtos ?? []) {
    const cat = String(p.categoria ?? "").trim() || "Outros"
    if (!grupos.has(cat)) grupos.set(cat, [])
    grupos.get(cat)!.push(p)
  }
  return [...grupos.entries()]
    .map(([cat, ps]) => `【${cat.toUpperCase()}】\n${ps.map(linhaDoCardapio).join("\n")}`)
    .join("\n\n")
}

/**
 * Preço citado pelo modelo ao lado do nome EXATO de um produto tem que ser um
 * dos preços dele (normal, promoção ou faixa). Se não for, troca pelo normal.
 * Pega o "Balde 10 litros de sorvete — R$ 125,00" antes de o cliente ler.
 */
function corrigirPrecosCitados(texto: string, produtos: any[], montados: Set<string> = new Set()): string {
  const norm = (s: string) => String(s ?? "").normalize("NFD").replace(RE_ACENTOS_PRECO, "").toLowerCase().replace(/[*_]/g, "")
  const ordenados = [...(produtos ?? [])].sort((a, b) => String(b.nome).length - String(a.nome).length)
  return texto.split("\n").map(linha => {
    const ln = norm(linha)
    const prod = ordenados.find(p => String(p.nome).length >= 6 && ln.includes(norm(p.nome)))
    if (!prod) return linha
    // Produto montado com complementos (pizza com borda, meio a meio): o valor
    // certo é base + escolhas, que não está na lista de preços dele. "Mussarela
    // com borda cheddar R$ 38,99" virava R$ 31,99, e a Pizza 2 Sabores, R$ 0,00.
    if (montados.has(String(prod.id)) || /\b(meia|metade|borda|sabores)\b/i.test(linha)) return linha
    const m = linha.match(/R\$\s*([\d.]+(?:,\d{1,2})?|\d+(?:\.\d{1,2})?)/)
    if (!m) return linha
    const citado = Number(m[1].includes(",") ? m[1].replace(/\./g, "").replace(",", ".") : m[1])
    const base = Number(prod.preco_venda) || 0
    const validos = [base, Number(prod.preco_promocional) || 0, ...faixasOrdenadas(prod.faixas_preco).map(f => f.preco)].filter(v => v > 0)
    if (!Number.isFinite(citado) || validos.some(v => Math.abs(v - citado) < 0.01)) return linha
    // Linha de item com quantidade ("x2 — R$ 24", "70 un — R$ 42,00") é total,
    // não unitário: não mexe. O "70 un" é o da conferência da sacola — virava
    // "R$ 1,50" ao lado de 70 picolés (CDBom, 15/09/2026).
    if (/\bx\s*\d+|\d+\s*x\b|\b\d+\s*un\b/i.test(linha)) return linha
    console.log(`[Preço citado] ${prod.nome}: R$ ${citado} → R$ ${base}`)
    return linha.replace(m[0], `R$ ${base.toFixed(2).replace(".", ",")}`)
  }).join("\n")
}
const RE_ACENTOS_PRECO = new RegExp("[\\u0300-\\u036f]", "g")

/** Como o produto aparece na lista do prompt: preço, promoção, atacado e descrição. */
function linhaDoCardapio(p: any): string {
  const rs = (v: number) => `R$ ${Number(v).toFixed(2)}`
  const base = Number(p.preco_venda) || 0
  const promo = Number(p.preco_promocional) || 0
  let preco = promo > 0 && promo < base ? `de ${rs(base)} por ${rs(promo)} (PROMOÇÃO)` : rs(base)
  const faixas = faixasOrdenadas(p.faixas_preco).reverse()
  if (faixas.length) preco += " | " + faixas.map(f => `a partir de ${f.qtd_min} un: ${rs(f.preco)} cada`).join(" | ")
  const desc = String(p.descricao ?? "").replace(/\s+/g, " ").trim()
  const descCurta = desc.length > 110 ? desc.slice(0, 107) + "..." : desc
  return `• ${p.nome} [id:${p.id}] — ${preco} (${p.embalagem || "un"})${descCurta ? ` — ${descCurta}` : ""}`
}

const PALAVRAS_SEM_PRODUTO = new Set([
  "quero", "queria", "gostaria", "tem", "temos", "tens", "voces", "vcs", "voce",
  "quanto", "quantos", "custa", "preco", "valor", "para", "pra", "com", "sem",
  "uma", "uns", "umas", "dos", "das", "que", "qual", "quais", "por", "favor",
  "bom", "boa", "dia", "tarde", "noite", "oi", "ola", "sim", "nao", "obrigado",
  "entrega", "entregar", "taxa", "frete", "endereco", "horario", "pedido",
  "fechar", "isso", "mais", "menos", "tudo", "aqui", "ali", "unidade", "caixa",
  "fardo", "duzia", "litro", "litros",
])

function termosDoCliente(textos: string[]): string[] {
  const vistos = new Set<string>()
  const termos: string[] = []
  for (const t of textos) {
    const limpo = String(t ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
    for (const palavra of limpo.split(/ +/)) {
      if (palavra.length < 3) continue
      if (PALAVRAS_SEM_PRODUTO.has(palavra)) continue
      if (/^[0-9]+$/.test(palavra)) continue
      if (vistos.has(palavra)) continue
      vistos.add(palavra)
      termos.push(palavra)
    }
  }
  // As falas mais novas vêm primeiro: é o que ele está pedindo AGORA.
  return termos.slice(0, 6)
}

async function catalogoRelevante(
  supabase: any,
  empresaId: string,
  falasDoCliente: string[],
  idsNoCarrinho: string[],
): Promise<any[]> {
  const termos = termosDoCliente(falasDoCliente)
  const ids = new Set<string>(idsNoCarrinho)

  // buscar_produto_nome casa nome E categoria, sem acento (migs 0227/0232) —
  // "acai" acha "Açaí", "refrigerante" acha a Coca pela categoria.
  const buscas = await Promise.all(termos.map(termo =>
    supabase.rpc("buscar_produto_nome", { p_empresa: empresaId, p_termo: termo, p_limite: 20 })
  ))
  for (const r of buscas as any[]) {
    for (const p of (r?.data ?? [])) {
      if (ids.size >= MENU_BUSCA_MAX) break
      ids.add(p.id)
    }
  }
  if (!ids.size) return []

  // A busca devolve id/nome/preço; o prompt precisa da embalagem também, e o
  // preço tem que sair da tabela (a RPC não conhece preço especial de cliente).
  const { data } = await supabase.from("produtos")
    .select(PRODUTO_COLUNAS)
    .eq("empresa_id", empresaId)
    .eq("ativo", true)
    .in("id", [...ids])
    .order("nome")
  return (data ?? []) as any[]
}

// ── Formas de pagamento da loja ──────────────────────────────────────────────
// O robô só conhecia "dinheiro ou cartão" (+ PIX online com Mercado Pago) e
// ignorava o que a loja marcou em Minha Loja → Pagamento. A CDBom aceita PIX NA
// ENTREGA (direto na chave dela, sem gateway) e o robô nem oferecia. Mesma lista
// que liga os botões da Loja Online (src/lib/constants.js):
//   pix         → cobrança online, exige MP conectado
//   pix_entrega → paga na entrega, na chave PIX da loja
type Pagamentos = {
  dinheiro: boolean; pixOnline: boolean; pixEntrega: boolean
  credito: boolean; debito: boolean; cartao: boolean
  chavePix: string; pixNome: string
}

function pagamentosDaLoja(empresa: any): Pagamentos {
  const mp = empresa?.mp_conectado === true
  const lista: string[] = Array.isArray(empresa?.formas_pagamento) ? empresa.formas_pagamento.map(String) : []
  const chavePix = String(empresa?.chave_pix ?? "").trim()
  const pixNome = String(empresa?.pix_nome ?? "").trim()
  // Loja que nunca abriu a tela de pagamento: o comportamento de antes.
  if (!lista.length) {
    return { dinheiro: true, pixOnline: mp, pixEntrega: false, credito: false, debito: false, cartao: true, chavePix, pixNome }
  }
  const p: Pagamentos = {
    dinheiro: lista.includes("dinheiro"),
    pixOnline: mp && lista.includes("pix"),
    pixEntrega: lista.includes("pix_entrega"),
    credito: lista.includes("credito"),
    debito: lista.includes("debito"),
    cartao: lista.includes("cartao"),
    chavePix, pixNome,
  }
  if (!p.dinheiro && !p.pixOnline && !p.pixEntrega && !p.credito && !p.debito && !p.cartao) p.dinheiro = true
  return p
}

const aceitaCartao = (p: Pagamentos) => p.credito || p.debito || p.cartao
const RE_ACENTOS_PGTO = new RegExp("[\\u0300-\\u036f]", "g")

/** "*dinheiro*, *PIX na entrega* ou *cartão*" — o que o robô pergunta. */
function opcoesDePagamento(p: Pagamentos): string {
  const ops: string[] = []
  if (p.dinheiro) ops.push("*dinheiro*")
  if (p.pixOnline) ops.push("*PIX*")
  if (p.pixEntrega) ops.push(p.pixOnline ? "*PIX na entrega*" : "*PIX*")
  if (aceitaCartao(p)) ops.push("*cartão*")
  return ops.length > 1 ? `${ops.slice(0, -1).join(", ")} ou ${ops[ops.length - 1]}` : ops[0]
}

/** O que o modelo (ou a conversa) mandou → o valor que a loja realmente aceita. */
function normalizarFormaPgto(forma: any, p: Pagamentos): string {
  const f = String(forma ?? "").normalize("NFD").replace(RE_ACENTOS_PGTO, "").toLowerCase().trim()
  const cartaoPadrao = p.cartao ? "cartao" : (p.credito && !p.debito) ? "credito" : (p.debito && !p.credito) ? "debito" : "cartao"
  if (/pix.*entrega|entrega.*pix|pix_entrega/.test(f)) return p.pixEntrega ? "pix_entrega" : p.pixOnline ? "pix" : "pix_entrega"
  if (/pix/.test(f)) return p.pixOnline ? "pix" : "pix_entrega"
  if (/credito/.test(f)) return p.credito ? "credito" : cartaoPadrao
  if (/debito/.test(f)) return p.debito ? "debito" : cartaoPadrao
  if (/cart|maquin/.test(f)) return cartaoPadrao
  if (/dinh|especie/.test(f)) return "dinheiro"
  return f || "dinheiro"
}

function rotuloPgto(forma: string): string {
  return ({ pix: "PIX", pix_entrega: "PIX na entrega", credito: "cartão de crédito", debito: "cartão de débito", cartao: "cartão", dinheiro: "dinheiro" } as Record<string, string>)[forma] ?? forma
}

// ── Troco ────────────────────────────────────────────────────────────────────
/** "R$ 200", "200,00", "uma de 100" → número. Sem número, null. */
function valorEmReais(txt: string): number | null {
  const m = String(txt ?? "").match(/(\d{1,5}(?:\.\d{3})*(?:[.,]\d{1,2})?)/)
  if (!m) return null
  let s = m[1]
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".")
  else if (/\.\d{3}$/.test(s)) s = s.replace(/\./g, "")
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** A resposta do cliente logo depois de o robô perguntar do troco. */
function trocoDaConversa(mensagens: any[]): number | null {
  for (let i = (mensagens ?? []).length - 2; i >= 0; i--) {
    const m = mensagens[i]
    if (m?.role !== "assistant" || !/troco/i.test(m.content ?? "")) continue
    const resp = mensagens[i + 1]
    if (resp?.role !== "user") continue
    // Número manda ("não tenho trocado, é nota de 100"); valor menor que o
    // total quem descarta é o fechamento.
    const valor = valorEmReais(resp.content ?? "")
    if (valor != null) return valor
    if (/\b(n[ãa]o|sem troco|trocado|certinho|exato)\b/i.test(resp.content ?? "")) return null
    // "sim" / "confirmo" depois do resumo: o valor foi dito antes, segue voltando.
  }
  return null
}

// ── handleFecharPedido ───────────────────────────────────────────────────────
async function handleFecharPedido(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  phoneLocal: string,
  acao: any,
  carrinho: any[],
  cliente: any,
  empresa: any,
  supabase_url: string,
  supabase_key: string,
  instanceName: string,
  carrinhoEndereco: { rua: string|null; numero: string|null; bairro: string|null; cidade: string|null; estado?: string|null; lat?: number|null; lng?: number|null },
  indicadorProfileId: string|null = null,
  taxaEntregaCalc: number|null = null,
  mensagensHist: any[] = [],
  catalogoProdutos: any[] = [],
  precoOpcaoMap: Record<string, number> = {},
  regrasOpcao: RegrasOpcao = {}
): Promise<{ mensagemExtra: string; acaoPromise: Promise<any>; pixCode?: string; pixQrBase64?: string; pixNumero?: string; bloqueioMensagem?: string }> {
  console.log(`[Pedido] fechando para ${phone}, pgto: ${acao.forma_pagamento}`)
  try {
    // Re-fetch carrinho se vazio (pode ser sobrescrito por buscar_cep ou outro upsert)
    let itens = carrinho
    if (itens.length === 0) {
      const { data: freshCart } = await supabase.from("whatsapp_carrinho")
        .select("items").eq("empresa_id", empresaId).eq("phone", phone).single()
      if ((freshCart?.items ?? []).length > 0) {
        itens = freshCart!.items
        console.log(`[Pedido] carrinho re-fetched: ${itens.length} itens`)
      }
    }
    // Fallback: itens passados diretamente no ACAO pelo Claude (proteção se o DB não sincronizou)
    if (itens.length === 0 && Array.isArray(acao.items) && acao.items.length > 0) {
      itens = acao.items
      console.log(`[Pedido] carrinho do ACAO (fallback): ${itens.length} itens`)
    }
    // Rede de segurança: completa itens que o cliente CONFIRMOU no resumo mas que
    // não estão no carrinho (o modelo às vezes diz "adicionado" e não grava). Assim
    // o total COBRADO bate com o que foi mostrado. Só adiciona o que falta.
    itens = reconciliarComResumo(itens, mensagensHist, catalogoProdutos)
    // Preço de novo pela quantidade final: item que veio do resumo ou do ACAO
    // não passou pelo atualizar_carrinho, e sem isto saía sem o atacado.
    reprecificarItens(itens, catalogoProdutos, precoOpcaoMap, regrasOpcao)
    if (itens.length === 0) {
      console.error("[Pedido] abortado — carrinho vazio mesmo após re-fetch e fallback")
      return { mensagemExtra: "⚠️ Não encontrei itens no carrinho. Pode me falar novamente o que gostaria de pedir? 😊", acaoPromise: Promise.resolve() }
    }

    const taxaEntrega    = Number(empresa.taxa_entrega ?? 0)
    const tipoEntrega    = acao.tipo_entrega === "entrega" ? "entrega" : "retirada"
    const formaPgto      = normalizarFormaPgto(acao.forma_pagamento ?? "dinheiro", pagamentosDaLoja(empresa))

    const endRua    = acao.cliente_rua    ? String(acao.cliente_rua).trim()    : (carrinhoEndereco.rua    ?? cliente?.endereco ?? null)
    const endNumero = acao.cliente_numero ? String(acao.cliente_numero).trim() : (carrinhoEndereco.numero ?? cliente?.numero   ?? null)
    const endBairro = acao.cliente_bairro ? String(acao.cliente_bairro).trim() : (carrinhoEndereco.bairro ?? cliente?.bairro   ?? null)
    const endCidade = acao.cliente_cidade ? String(acao.cliente_cidade).trim() : (carrinhoEndereco.cidade ?? cliente?.cidade   ?? null)
    const endEstado = acao.cliente_estado ? String(acao.cliente_estado).trim() : (carrinhoEndereco.estado ?? cliente?.estado ?? null)
    // O PONTO. Sem ele o pedido saía só com o texto do endereço, e o app do
    // entregador jogava esse texto no Google — que, sem confiar no número,
    // larga o pino no meio da rua. Ordem: o que o cliente mandou agora, senão o
    // pino que ele já tinha apontado no cadastro.
    const endLat = carrinhoEndereco.lat ?? cliente?.endereco_lat ?? null
    const endLng = carrinhoEndereco.lng ?? cliente?.endereco_lng ?? null

    if (tipoEntrega === "entrega" && !endRua) {
      return {
        mensagemExtra: "",
        acaoPromise: Promise.resolve(),
        bloqueioMensagem: "📍 Preciso do seu endereço para entrega!\n\n" +
          "Me diz o *nome da rua*, o *número* e o *bairro* que eu já anoto. 😊\n\n" +
          "_Se preferir, me manda o CEP._",
      }
    }
    const totalCarrinho  = itens.reduce((s: number, i: any) => s + Number(i.qtd) * Number(i.preco), 0)

    // Pedido mínimo p/ ENTREGA (só produtos; retirada não exige). Bloqueia ANTES de
    // gravar qualquer coisa — mesmo padrão do bloqueio de endereço acima.
    const pedidoMinimo = Number(empresa.pedido_minimo ?? 0)
    if (tipoEntrega === "entrega" && pedidoMinimo > 0 && totalCarrinho < pedidoMinimo) {
      const falta = pedidoMinimo - totalCarrinho
      const rs = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`
      return {
        mensagemExtra: "",
        acaoPromise: Promise.resolve(),
        bloqueioMensagem: `🛒 O pedido mínimo para *entrega* é *${rs(pedidoMinimo)}* (só os produtos).\n\nFaltam *${rs(falta)}* pra fechar. Quer adicionar mais alguma coisa? 😊\n\n_Se preferir, também dá pra escolher *retirada* na loja._`,
      }
    }

    // Taxa: usa a calculada pela distância (quando veio); senão cai na fixa da loja.
    // A taxa é recalculada AQUI, com o endereço que vai no pedido. O valor que
    // vinha de cima foi calculado no começo da mensagem, quando o endereço
    // muitas vezes ainda não existia — e aí a loja entregava de graça: o pedido
    // #1061 saiu com endereço completo e taxa R$ 0,00 por causa disso.
    let taxaFinal = tipoEntrega === "entrega" ? (taxaEntregaCalc != null ? taxaEntregaCalc : taxaEntrega) : 0
    if (tipoEntrega === "entrega" && endRua) {
      const cfgB = acharBairroCfg(empresa.taxas_entrega_bairro, endBairro)
      if (cfgB && cfgB.entrega !== false) {
        taxaFinal = Number(cfgB.taxa) || 0
        console.log(`[Taxa] bairro "${endBairro}" → R$${taxaFinal}`)
      } else {
        const enderecoFinal = [endRua, endNumero, endBairro, endCidade ?? empresa.cidade].filter(Boolean).join(", ")
        const t = await calcularTaxaEntregaKm(empresa, enderecoFinal)
        // Só troca quando a conta fecha: geocode que falhou não pode virar
        // frete grátis.
        if (t != null) taxaFinal = t
      }
    }
    const totalFinal     = totalCarrinho + taxaFinal
    // Troco: o que o modelo mandou na ação ou, se ele esqueceu, o que o cliente
    // respondeu à pergunta do troco. Nota menor que o total não é troco — o
    // entregador sairia com o valor errado, então fica sem.
    let trocoPara: number | null = null
    if (formaPgto === "dinheiro") {
      const bruto = acao.troco_para != null && acao.troco_para !== "" ? valorEmReais(String(acao.troco_para)) : trocoDaConversa(mensagensHist)
      if (bruto != null && bruto > totalFinal) trocoPara = bruto
      else if (bruto != null) console.log(`[Troco] ignorado: R$ ${bruto} não passa do total R$ ${totalFinal.toFixed(2)}`)
    }

    let clienteId         = cliente?.id ?? null
    let clienteTel        = cliente?.telefone ?? phoneLocal
    let clienteNomeInsert = cliente?.nome ?? ""
    let clienteEmail      = cliente?.email ?? null
    let mensagemExtra     = ""

    if (!clienteId && acao.cliente_nome) {
      const nomeCliente = String(acao.cliente_nome).trim()
      const emailReal   = acao.cliente_email ? String(acao.cliente_email).trim().toLowerCase() : null
      const emailLogin  = emailReal || `${phoneLocal}@wpp.vendamais.app`
      const telCliente  = acao.cliente_telefone ? String(acao.cliente_telefone).replace(/\D/g, "") : phoneLocal

      // 0. SELECT-first: cliente pode já existir de sessão anterior ou ter o mesmo email/telefone que a conta da loja
      const { data: clienteJaExiste } = await supabase
        .from("clientes")
        .select("id, nome, telefone, email, created_at, origem, user_id")
        .eq("empresa_id", empresaId)
        .eq("telefone", telCliente)
        .order("created_at", { ascending: false })
        .limit(1).maybeSingle()

      if (clienteJaExiste) {
        clienteId         = clienteJaExiste.id
        clienteNomeInsert = clienteJaExiste.nome ?? nomeCliente
        clienteTel        = clienteJaExiste.telefone ?? telCliente
        clienteEmail      = clienteJaExiste.email ?? emailReal
        console.log(`[Cliente] já existe id=${clienteId}`)
        // Salva endereço no profile global se ainda não tiver
        if (clienteJaExiste.user_id && endRua) {
          await supabase.from("profiles").update({
            endereco: endRua, numero: endNumero ?? null,
            bairro: endBairro ?? null, cidade: endCidade ?? null, estado: endEstado ?? null,
          }).eq("id", clienteJaExiste.user_id).is("endereco", null)
        }
        // Cliente só da loja — sem conta no app, sem credenciais/senha.
      } else {
        // Cliente do WhatsApp é SÓ da loja — não cria conta no app (sem auth user, sem senha).
        const authUserId: string | null = null

        // 2. INSERT via fetch direto ao PostgREST (mais robusto que supabase.from().insert())
        try {
          const cliPayload = {
            empresa_id: empresaId, nome: nomeCliente, telefone: telCliente, email: emailReal,
            user_id: authUserId,
            tipo: "pessoa_fisica", condicao_pagamento: "a_vista",
            limite_credito: 0, desconto_percentual: 0, desconto_minimo_pedido: 0,
            origem: "whatsapp",
          }
          const cliRes = await fetch(`${supabase_url}/rest/v1/clientes`, {
            method: "POST",
            headers: {
              "apikey": supabase_key,
              "Authorization": `Bearer ${supabase_key}`,
              "Content-Type": "application/json",
              "Prefer": "return=representation",
            },
            body: JSON.stringify(cliPayload),
          })
          const cliText = await cliRes.text()
          console.log(`[Cliente] INSERT status=${cliRes.status} resp=${cliText.slice(0, 400)}`)

          if (cliRes.ok) {
            try {
              const rows = JSON.parse(cliText)
              const row  = Array.isArray(rows) ? rows[0] : rows
              if (row?.id) {
                clienteId         = row.id
                clienteNomeInsert = row.nome ?? nomeCliente
                clienteTel        = row.telefone ?? telCliente
                clienteEmail      = row.email ?? emailReal
                console.log(`[Cliente] criado id=${clienteId}`)
              }
            } catch (parseErr) {
              console.error("[Cliente] parse resp err:", String(parseErr))
            }
          }

          // Fallback: se INSERT não retornou ID, busca por telefone
          if (!clienteId) {
            const { data: porTel } = await supabase.from("clientes").select("id, nome, telefone, email")
              .eq("empresa_id", empresaId).eq("telefone", telCliente)
              .order("created_at", { ascending: false }).limit(1).maybeSingle()
            if (porTel) {
              clienteId = porTel.id; clienteNomeInsert = porTel.nome ?? nomeCliente
              clienteTel = porTel.telefone ?? telCliente; clienteEmail = porTel.email ?? emailReal
              console.log(`[Cliente] fallback tel id=${clienteId}`)
            }
          }

          // Fallback 2: busca por user_id
          if (!clienteId && authUserId) {
            const { data: porUid } = await supabase.from("clientes").select("id, nome, telefone, email")
              .eq("empresa_id", empresaId).eq("user_id", authUserId).maybeSingle()
            if (porUid) {
              clienteId = porUid.id; clienteNomeInsert = porUid.nome ?? nomeCliente
              clienteTel = porUid.telefone ?? telCliente; clienteEmail = porUid.email ?? emailReal
              console.log(`[Cliente] fallback uid id=${clienteId}`)
            }
          }

          // Fallback 3: busca por email real
          if (!clienteId && emailReal) {
            const { data: porEmail } = await supabase.from("clientes").select("id, nome, telefone, email")
              .eq("empresa_id", empresaId).eq("email", emailReal).maybeSingle()
            if (porEmail) {
              clienteId = porEmail.id; clienteNomeInsert = porEmail.nome ?? nomeCliente
              clienteTel = porEmail.telefone ?? telCliente; clienteEmail = porEmail.email ?? emailReal
              console.log(`[Cliente] fallback email id=${clienteId}`)
            }
          }
        } catch (cliErr) {
          console.error("[Cliente] exceção INSERT:", String(cliErr))
        }

        if (authUserId && indicadorProfileId) {
          await supabase.from("profiles").update({ indicado_por: indicadorProfileId }).eq("id", authUserId)
        }

        // Salva endereço no profile global se ainda não tiver
        if (authUserId && endRua) {
          await supabase.from("profiles").update({
            endereco: endRua, numero: endNumero ?? null,
            bairro: endBairro ?? null, cidade: endCidade ?? null, estado: endEstado ?? null,
          }).eq("id", authUserId).is("endereco", null)
        }

        // Cliente só da loja — sem conta no app, sem credenciais/senha.
      }
    }

    if (!clienteId) {
      console.error(`[Pedido] abortado — clienteId null. acao.cliente_nome="${acao.cliente_nome}"`)
      return { mensagemExtra: "", acaoPromise: Promise.resolve() }
    }

    // Salva endereço no cadastro do cliente desta loja (para próximos pedidos não pedirem CEP de novo)
    if (endRua && clienteId && tipoEntrega === "entrega") {
      await supabase.from("clientes").update({
        endereco: endRua, numero: endNumero ?? null,
        bairro: endBairro ?? null, cidade: endCidade ?? null, estado: endEstado ?? null,
      }).eq("id", clienteId)
    }

    // Salva endereço no profile global — cobre todos os caminhos (cliente já existia, recém-cadastrado, etc)
    if (endRua && clienteId) {
      const { data: cliForProfile } = await supabase
        .from("clientes").select("user_id").eq("id", clienteId).maybeSingle()
      if (cliForProfile?.user_id) {
        await supabase.from("profiles").update({
          endereco: endRua, numero: endNumero ?? null,
          bairro: endBairro ?? null, cidade: endCidade ?? null, estado: endEstado ?? null,
        }).eq("id", cliForProfile.user_id).is("endereco", null)
      }
    }

    if (formaPgto === "pix") {
      const pixRes = await fetch(`${supabase_url}/functions/v1/create-pix-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabase_key}` },
        body: JSON.stringify({
          pedido: {
            empresa_id: empresaId, empresa_nome: empresa.nome ?? "Loja",
            cliente_id: clienteId, cliente_nome: clienteNomeInsert, cliente_telefone: clienteTel,
            payer_email: clienteEmail ?? `${phoneLocal}@wpp.vendamais.app`,
            itens: itens, total: totalFinal, subtotal: totalCarrinho, taxa_entrega: taxaFinal,
            tipo_entrega: tipoEntrega,
            endereco_rua: endRua, endereco_numero: endNumero, endereco_bairro: endBairro,
            endereco_cidade: endCidade, endereco_estado: endEstado,
            endereco_lat: tipoEntrega === "entrega" ? endLat : null,
            endereco_lng: tipoEntrega === "entrega" ? endLng : null,
          }
        }),
      })
      if (!pixRes.ok) {
        console.error("[PIX] create-pix-payment falhou:", await pixRes.text())
        return { mensagemExtra: "⚠️ Erro ao gerar PIX. Tente cartão ou dinheiro.", acaoPromise: Promise.resolve() }
      }
      const pixData = await pixRes.json()

      // O QR sai pelo cano certo. `instanceName` começando com "cloud_" é loja
      // na API oficial da Meta: mandar pelo Evolution ali é falar com uma
      // instância que não existe — o cliente ficava com o "⬇️ Código PIX:" e
      // NADA embaixo. Nesse caso o QR volta pra quem chamou (o whatsapp-cloud),
      // que sabe subir a imagem na Graph API.
      const ehCloud = String(instanceName || "").startsWith("cloud_")
      if (!ehCloud) {
        await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${instanceName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({
            number: phone, mediatype: "image",
            media: `data:image/png;base64,${pixData.qr_code_base64}`,
            caption: `📱 *QR Code PIX — Pedido #${pixData.numero_pedido ?? ""}*\n\n⏳ Você tem *5 minutos* para pagar.`,
          }),
        }).catch(e => console.error("[PIX] sendMedia erro:", e))
      }
      const acaoPromise = supabase.from("whatsapp_carrinho").delete().eq("empresa_id", empresaId).eq("phone", phone)
      return {
        mensagemExtra: `\n\n✅ Assim que confirmado, seu pedido vai para a loja!\n\n⬇️ *Código PIX:*`,
        acaoPromise,
        pixCode: pixData.qr_code,
        pixQrBase64: ehCloud ? pixData.qr_code_base64 : undefined,
        pixNumero: String(pixData.numero_pedido ?? ""),
      }
    }

    const pedidoPayload = {
      empresa_id: empresaId, cliente_id: clienteId, cliente_nome: clienteNomeInsert, cliente_telefone: clienteTel,
      endereco_rua: endRua, endereco_numero: endNumero, endereco_bairro: endBairro,
      endereco_cidade: endCidade, endereco_estado: endEstado,
      endereco_lat: tipoEntrega === "entrega" ? endLat : null,
      endereco_lng: tipoEntrega === "entrega" ? endLng : null,
      itens: itens, subtotal: totalCarrinho, taxa_entrega: taxaFinal, total: totalFinal,
      forma_pagamento: formaPgto, tipo_entrega: tipoEntrega,
      troco_para: trocoPara,
      pix_status: formaPgto === "pix" ? "pendente" : "nao_aplicavel",
      origem: "whatsapp",
      status: "aguardando", aguardando_desde: new Date().toISOString(),
    }
    const pedidoRes  = await fetch(`${supabase_url}/rest/v1/pedidos_delivery`, {
      method: "POST",
      headers: {
        "apikey": supabase_key,
        "Authorization": `Bearer ${supabase_key}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
      },
      body: JSON.stringify(pedidoPayload),
    })
    const pedidoText = await pedidoRes.text()
    console.log(`[Pedido] INSERT status=${pedidoRes.status} resp=${pedidoText.slice(0, 400)}`)
    let pedidoNovo: any = null
    if (pedidoRes.ok) {
      try {
        const rows = JSON.parse(pedidoText)
        pedidoNovo = Array.isArray(rows) ? rows[0] : rows
      } catch {}
    } else {
      console.error(`[Pedido] INSERT falhou: ${pedidoText.slice(0, 400)}`)
    }

    // Link do mapa que o robô mandou e o cliente ainda não confirmou: amarra no
    // pedido. Quem arrasta o pino DEPOIS de fechar (o normal — ele fecha e só
    // então abre o link) corrige o ponto do pedido que vai pra rua, e não só o
    // cadastro (confirmar_pin_link atualiza o pedido pelo pedido_id, mig 0240).
    if (pedidoNovo?.id && tipoEntrega === "entrega") {
      const { error: pinErr } = await supabase.from("pin_links")
        .update({ pedido_id: pedidoNovo.id })
        .eq("empresa_id", empresaId)
        .is("confirmado_em", null)
        .gt("expira_em", new Date().toISOString())
        .like("telefone", `%${phone.replace(/\D/g, "").slice(-8)}`)
      if (pinErr) console.error("[Pino] amarrar link ao pedido:", pinErr.message)
    }

    // Pedido de entrega que saiu SEM ponto (endereço escrito, cadastro antigo,
    // CEP): o link vai junto da confirmação, já amarrado ao pedido. Pega todos
    // os caminhos do endereço de uma vez — o do salvar_numero é só o primeiro.
    let linhaPino = ""
    if (pedidoNovo?.id && tipoEntrega === "entrega" && (endLat == null || endLng == null) && endRua) {
      const { data: pin, error: pinErr } = await supabase.rpc("criar_pin_link_para", {
        p_empresa_id: empresaId, p_telefone: phone,
        p_rua: endRua, p_numero: endNumero, p_bairro: endBairro, p_cidade: endCidade,
        p_estado: endEstado, p_cep: null, p_lat: null, p_lng: null, p_pedido_id: pedidoNovo.id,
      })
      if (pinErr) console.error("[Mapa] link no fechamento:", pinErr.message)
      else if (pin?.ok) {
        linhaPino = `\n\n📌 *Confere o ponto da entrega* pro entregador ir direto na sua porta:\n👉 https://lojaonline.fwcinter.com/local/${pin.token}\n_Se estiver em casa agora, toque em *usar minha localização* — fica exato. Se não estiver, arraste o pino._`
      }
    }

    const acaoPromise    = supabase.from("whatsapp_carrinho").delete().eq("empresa_id", empresaId).eq("phone", phone)
    const numPedido      = pedidoNovo?.numero_pedido ?? ""
    const labelPgto      = rotuloPgto(formaPgto)
    const labelEntrega   = tipoEntrega === "entrega" ? "na entrega" : "na retirada"

    // Cliente só da loja — sem conta no app, sem credenciais/senha (sem mensagem de senha).

    // A taxa e o total saem daqui, do cálculo do sistema — não do resumo que o
    // modelo escreveu. Ele já chutou "R$ 15,00" de taxa numa conversa em que
    // endereço nenhum tinha sido calculado; o cliente tem que ver o valor real.
    const linhaValores = tipoEntrega === "entrega"
      ? `\n🚚 Taxa de entrega: *R$ ${taxaFinal.toFixed(2)}*\n💰 Total: *R$ ${totalFinal.toFixed(2)}*`
      : `\n💰 Total: *R$ ${totalFinal.toFixed(2)}*`
    // PIX na entrega: a chave vai junto, pro cliente já deixar salvo e pagar
    // quando o pedido chegar.
    const pgLoja = pagamentosDaLoja(empresa)
    const linhaPixEntrega = formaPgto === "pix_entrega"
      ? (pgLoja.chavePix
        ? `\n📱 Chave PIX da loja: *${pgLoja.chavePix}*${pgLoja.pixNome ? ` (${pgLoja.pixNome})` : ""}\n${tipoEntrega === "entrega"
          ? "_Faça o PIX e mande o comprovante aqui pra concluir o pedido. 🧾_"
          : "_Faça o PIX e mande o comprovante aqui pra concluir o pedido. 🧾_"}`
        // PIX manual é pago ANTES, com comprovante na conversa — o mesmo que a
        // Loja Online pede. O robô mandava pagar na entrega (CDBom, 14/09/2026).
        : `\n📱 A loja te passa a chave PIX por aqui — é só fazer o PIX e mandar o comprovante. 🧾`)
      : ""
    const linhaTroco = trocoPara ?`\n💵 Troco para *R$ ${trocoPara.toFixed(2)}* (volta R$ ${(trocoPara - totalFinal).toFixed(2)})` : ""
    mensagemExtra = `🧾 *Pedido #${numPedido} recebido!*${linhaValores}\n\n💳 Pagamento em *${formaPgto === "pix_entrega" ? "PIX" : labelPgto}*${formaPgto === "pix_entrega" ? "" : ` ${labelEntrega}`}.${linhaPixEntrega}${linhaTroco}${linhaPino}\n\n⏳ Aguardando a loja confirmar — assim que confirmarem você recebe uma mensagem aqui! 🎉` + mensagemExtra
    return { mensagemExtra, acaoPromise }
  } catch (e) {
    console.error("[Pedido] erro:", e)
    return { mensagemExtra: "", acaoPromise: Promise.resolve() }
  }
}

// ── getMediaBase64 — baixa mídia da Evolution API ───────────────────────────
async function getMediaBase64(instanceName: string, msg: any): Promise<{ base64: string; mimetype: string } | null> {
  try {
    const res = await fetch(`${EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ message: msg }),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data?.base64) return null
    return { base64: data.base64, mimetype: data.mimetype ?? "application/octet-stream" }
  } catch (e: any) {
    console.error("[Media] getBase64 erro:", e?.message)
    return null
  }
}

// ── extrairItensDoResumo — backstop quando o carrinho ficou vazio ────────────
// O Haiku às vezes diz "anotado" sem emitir atualizar_carrinho. Pra o pedido não
// se perder, extraímos os itens do último resumo/lista que o bot mostrou.
// Aceita "x1" ou "x 1"; o valor é o TOTAL da linha (divide pela qtd pro unitário).
function extrairItensDoResumo(mensagens: any[]): any[] {
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i]
    if (m?.role !== "assistant") continue
    const content = m.content ?? ""
    const matches = [...content.matchAll(/•\s*(.+?)\s+x\s*(\d+)\s*[—–\-]+\s*R\$\s*([\d.,]+)/gi)]
    if (matches.length > 0) {
      return matches.map((ma: any) => {
        const qtd   = parseInt(ma[2], 10) || 1
        const total = parseFloat(String(ma[3]).replace(",", "."))
        return { nome: String(ma[1]).trim(), qtd, preco: +(total / qtd).toFixed(2) }
      })
    }
  }
  return []
}

// ── reconciliarComResumo — rede de segurança no FECHAMENTO ───────────────────
// Garante que TUDO que o cliente confirmou no último resumo esteja no pedido.
// Se o modelo disse "adicionado" mas esqueceu de gravar algum item no carrinho,
// a gente completa AQUI (casando pelo nome no catálogo) — assim o total COBRADO
// bate com o que foi mostrado/confirmado. Só ADICIONA o que falta: nunca remove
// nem altera o que já está no carrinho (não mexe no fluxo que já funciona).
const RE_ACENTOS = new RegExp("[\\u0300-\\u036f]", "g")
function normNomeSafe(s: string): string {
  return String(s ?? "").normalize("NFD").replace(RE_ACENTOS, "").toLowerCase().replace(/\s+/g, " ").trim()
}
function reconciliarComResumo(itens: any[], mensagens: any[], catalogo: any[]): any[] {
  const doResumo = extrairItensDoResumo(mensagens)
  if (!doResumo.length || !Array.isArray(catalogo) || !catalogo.length) return itens
  const nomesNoCarrinho = new Set((itens ?? []).map((i: any) => normNomeSafe(i.nome)))
  const idsNoCarrinho = new Set((itens ?? []).map((i: any) => String(i.produto_id ?? "")).filter(Boolean))
  const faltando: any[] = []
  for (const r of doResumo) {
    const nomeR = normNomeSafe(r.nome)
    if (!nomeR || nomesNoCarrinho.has(nomeR)) continue
    // Casa SÓ por nome exato (o bot escreve o nome do próprio catálogo) — evita
    // adicionar item errado. Se não achar no catálogo, não inventa.
    const prod = catalogo.find((p: any) => normNomeSafe(p.nome) === nomeR)
    if (!prod) continue
    // Já está no carrinho por produto_id (mesmo item com nome escrito diferente,
    // ex.: quentinha com complementos)? Então NÃO duplica.
    if (idsNoCarrinho.has(String(prod.id))) continue
    faltando.push({
      produto_id: prod.id,
      nome: prod.nome,
      qtd: Math.max(1, Number(r.qtd) || 1),
      preco: Number(prod.preco_venda ?? r.preco ?? 0),
    })
    nomesNoCarrinho.add(nomeR)
    idsNoCarrinho.add(String(prod.id))
  }
  if (faltando.length) {
    console.log(`[Fechar] Reconciliação: ${faltando.length} item(ns) confirmados no resumo faltavam no carrinho e foram incluídos: ${faltando.map((f) => f.nome).join(", ")}`)
    return [...(itens ?? []), ...faltando]
  }
  return itens
}

// ── Taxa de entrega por distância (mesma regra do gestor/PainelPedidos) ──────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
async function umGeocode(consulta: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const q = encodeURIComponent(`${consulta}, Brasil`)
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
      headers: { "User-Agent": "CRM-FWC/1.0" },
    })
    const data = await res.json()
    if (data?.[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
  } catch (e: any) { console.error("[Geo] erro:", e?.message) }
  return null
}

/**
 * Coordenada do endereço, tentando do mais específico ao menos.
 *
 * A cidade é o campo que mais atrapalha: quando o cliente não diz, o sistema
 * preenche com a da LOJA — e loja que entrega na cidade vizinha manda o mapa
 * procurar uma rua de São Gonçalo dentro de Natal. Não acha nada, a taxa volta
 * null e o pedido sai de graça. Então, se a busca completa falhar, tenta sem a
 * cidade e depois só pelo bairro.
 */
async function geocodificarEndereco(endereco: string): Promise<{ lat: number; lng: number } | null> {
  const partes = endereco.split(",").map(p => p.trim()).filter(Boolean)
  const tentativas = [endereco]
  if (partes.length >= 3) {
    // Sem a cidade (penúltima parte costuma ser ela quando veio do sistema)
    tentativas.push([...partes.slice(0, -1)].join(", "))
    // Só rua + bairro
    tentativas.push([partes[0], partes[partes.length - 2]].join(", "))
  }
  for (const t of tentativas) {
    const ponto = await umGeocode(t)
    if (ponto) {
      if (t !== endereco) console.log(`[Geo] achou na tentativa reduzida: "${t}"`)
      return ponto
    }
    // Nominatim limita 1 consulta por segundo — sem respiro ele devolve vazio.
    await new Promise(r => setTimeout(r, 1100))
  }
  console.log(`[Geo] não achei: "${endereco}"`)
  return null
}
// Normaliza bairro pra casar cliente <-> config (mesma regra da tela Raio de Entrega e do site).
// Mesmas abreviações que o gestor e o checkout entendem. Sem isto o robô lia
// "Nossa Sra. da Apresentação" (o jeito que o CEP mais devolve por aqui) como
// um bairro diferente de "Nossa Senhora da Apresentação" e perdia a taxa.
const ABREV_BAIRRO: Record<string, string> = {
  sra: "senhora", sr: "senhor", sto: "santo", sta: "santa",
  n: "nossa", na: "nossa", jd: "jardim", pq: "parque",
  vl: "vila", cj: "conjunto", res: "residencial", pres: "presidente",
}
function normBairro(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
    .replace(/^bairro\s+/, "").replace(/\./g, " ").replace(/\s+/g, " ")
    .split(" ").map(p => ABREV_BAIRRO[p] ?? p).join(" ").trim()
}
// Acha a linha da tabela de bairros da loja pro bairro que veio no endereço.
//
// Não dá pra exigir nome igualzinho: a loja escreve "Nossa Senhora" e o CEP
// devolve "Nossa Senhora da Apresentação"; escreve "Amarante" e vem "Novo
// Amarante". Com igualdade pura a taxa cadastrada simplesmente não pegava e o
// pedido caía na tabela por quilômetro sem ninguém entender por quê.
//
// A ordem: nome igual > o nome cadastrado aparece dentro do que veio > o que
// veio aparece dentro do nome cadastrado. Nos dois casos de "aparece dentro",
// ganha o nome MAIS ESPECÍFICO — senão "Redinha" roubaria o endereço de
// "Redinha Nova", que tem taxa própria.
function acharBairroCfg(lista: any, bairroCliente: string | null): any {
  const n = normBairro(bairroCliente || "")
  if (!n || !Array.isArray(lista)) return null
  const cfgs = lista
    .map((b: any) => ({ cfg: b, nome: normBairro(String(b?.bairro ?? "")) }))
    .filter((x: any) => x.nome)

  const exato = cfgs.find((x: any) => x.nome === n)
  if (exato) return exato.cfg

  const dentro = cfgs.filter((x: any) => x.nome.length >= 3 && n.includes(x.nome))
    .sort((a: any, b: any) => b.nome.length - a.nome.length)[0]
  if (dentro) return dentro.cfg

  const contem = cfgs.filter((x: any) => n.length >= 3 && x.nome.includes(n))
    .sort((a: any, b: any) => a.nome.length - b.nome.length)[0]
  return contem ? contem.cfg : null
}
// Taxa (número) pela distância entre a loja e o endereço, ou null se não deu pra calcular.
async function calcularTaxaEntregaKm(
  empresa: any,
  endStr: string,
  // Ponto que o cliente apontou (mig 0239). Quando existe, ele manda: veio do
  // celular dele, o geocode é chute em cima de texto.
  ponto: { lat: number; lng: number } | null = null,
): Promise<number | null> {
  try {
    if (!empresa?.latitude || !empresa?.longitude) return null
    const faixas = Array.isArray(empresa.taxas_entrega_km) ? empresa.taxas_entrega_km : []
    if (faixas.length === 0) return null
    const coords = ponto ?? await geocodificarEndereco(endStr)
    if (!coords) return null
    const dist = haversineKm(coords.lat, coords.lng, Number(empresa.latitude), Number(empresa.longitude))
    const ordenadas = [...faixas].sort((a: any, b: any) => a.km - b.km)
    const faixa = ordenadas.find((f: any) => dist <= Number(f.km)) ?? ordenadas[ordenadas.length - 1]
    console.log(`[Taxa] ${dist.toFixed(1)}km → R$${faixa.taxa}`)
    return Number(faixa.taxa) || 0
  } catch (e: any) { console.error("[Taxa] erro:", e?.message); return null }
}

// ── transcribeAudio — Whisper OpenAI ────────────────────────────────────────
async function transcribeAudio(base64: string, mimetype: string): Promise<string | null> {
  const openaiKey = Deno.env.get("OPENAI_API_KEY") ?? ""
  if (!openaiKey) return null
  try {
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const ext = mimetype.includes("ogg") ? "ogg" : mimetype.includes("mp4") ? "mp4" : "mp3"
    const form = new FormData()
    form.append("file", new Blob([binary], { type: mimetype }), `audio.${ext}`)
    form.append("model", "whisper-1")
    form.append("language", "pt")
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}` },
      body: form,
    })
    if (!res.ok) { console.error("[Whisper] erro:", await res.text()); return null }
    const data = await res.json()
    return data.text ?? null
  } catch (e: any) {
    console.error("[Whisper] erro:", e?.message)
    return null
  }
}

// ── O MODELO ÀS VEZES ESCREVE A AÇÃO NO FORMATO ERRADO ──────────────────────
//
// O combinado é "ACAO: {json}". Mas o Haiku às vezes cai no formato de
// ferramenta que ele aprendeu em outro lugar — <function_calls> com um array
// JSON dentro. Aí o `indexOf("ACAO:")` não acha nada, a ação NÃO É EXECUTADA e,
// pior, o bloco inteiro vai pro cliente: ele lê "function_calls", "produto_id",
// chaves e colchetes. Aconteceu em 05/09 com 10 Skol.
//
// Duas defesas, e as duas precisam existir:
//   1. entender o formato alternativo, pra ação rodar do mesmo jeito;
//   2. limpar QUALQUER resto de formato interno antes de mandar — mesmo o que
//      eu não previ. O cliente nunca pode ver a tripa do sistema.

const TIPOS_DE_ACAO = [
  "atualizar_carrinho", "verificar_cliente", "cadastrar_cliente", "pedir_cep",
  "buscar_cep", "salvar_rua", "salvar_numero", "fechar_pedido",
  "chamar_atendente", "escalar_humano", "pausar_bot",
]

// Acha o primeiro objeto JSON BALANCEADO a partir de uma posição.
function jsonBalanceado(txt: string, de: number): { texto: string; fim: number } | null {
  const ini = txt.indexOf("{", de)
  if (ini === -1) return null
  let nivel = 0
  let dentroDeAspas = false
  let escapando = false
  for (let i = ini; i < txt.length; i++) {
    const ch = txt[i]
    if (escapando) { escapando = false; continue }
    if (ch === "\\") { escapando = true; continue }
    if (ch === '"') { dentroDeAspas = !dentroDeAspas; continue }
    if (dentroDeAspas) continue
    if (ch === "{") nivel++
    else if (ch === "}") { nivel--; if (nivel === 0) return { texto: txt.slice(ini, i + 1), fim: i + 1 } }
  }
  return null
}

// Procura uma ação escrita de qualquer jeito e devolve o JSON + onde ele estava.
function acharAcaoSolta(txt: string): { json: string; ini: number; fim: number } | null {
  // Formato XML de ferramenta: <invoke name="atualizar_carrinho"><parameter
  // name="items">[...]</parameter></invoke>. O Haiku usou esse no teste da
  // CDBom (13/09) com os 10 picolés — a peneira limpava o bloco, o cliente lia
  // "anotei" e a sacola ficava vazia.
  const inv = /<invoke\s+name="([a-z_]+)"\s*>([\s\S]*?)(<[\/]invoke>|$)/i.exec(txt)
  if (inv && TIPOS_DE_ACAO.includes(inv[1])) {
    const obj: Record<string, unknown> = { tipo: inv[1] }
    for (const p of inv[2].matchAll(/<parameter\s+name="([a-z_]+)"\s*>([\s\S]*?)<[\/]parameter>/gi)) {
      const bruto = p[2].trim()
      try { obj[p[1]] = JSON.parse(bruto) } catch { obj[p[1]] = bruto }
    }
    const ini = txt.lastIndexOf("<function_calls>", inv.index) !== -1 ? txt.lastIndexOf("<function_calls>", inv.index) : inv.index
    const fechaBloco = txt.indexOf("</function_calls>", inv.index)
    const fim = fechaBloco !== -1 ? fechaBloco + "</function_calls>".length : inv.index + inv[0].length
    return { json: JSON.stringify(obj), ini, fim }
  }
  let de = 0
  while (de < txt.length) {
    const bloco = jsonBalanceado(txt, de)
    if (!bloco) return null
    try {
      const obj = JSON.parse(bloco.texto)
      // Formato direto {"tipo": ...} ou embrulhado {"arguments": {"tipo": ...}}
      const alvo = obj?.tipo ? obj : (obj?.arguments?.tipo ? obj.arguments : null)
      if (alvo && TIPOS_DE_ACAO.includes(String(alvo.tipo))) {
        return { json: JSON.stringify(alvo), ini: txt.indexOf("{", de), fim: bloco.fim }
      }
    } catch { /* não era JSON: segue procurando */ }
    de = (txt.indexOf("{", de) ?? de) + 1
  }
  return null
}

// Última peneira antes de mandar. Tira o que for tripa de sistema, mesmo o que
// não virou ação — bloco de ferramenta, cerca de código com JSON, "ACAO:" solto.
function limparRestosInternos(txt: string): string {
  let t = String(txt ?? "")
  t = t.replace(/<function_calls>[\s\S]*?(<[\/]function_calls>|$)/gi, " ")
  t = t.replace(/<[\/]?(function_calls|invoke|parameter|antml:[a-z_]+)[^>]*>/gi, " ")
  t = t.replace(/```[a-z]*[\s\S]*?```/gi, (m) => (/"tipo"|produto_id|function_calls/i.test(m) ? " " : m))
  // "ACAO: {...}" que sobrou (a ação já foi lida antes daqui)
  let i = t.indexOf("ACAO:")
  while (i !== -1) {
    const bloco = jsonBalanceado(t, i)
    t = bloco ? t.slice(0, i) + " " + t.slice(bloco.fim) : t.slice(0, i)
    i = t.indexOf("ACAO:")
  }
  return t.replace(/[ \t]{2,}/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim()
}

// ── serve ────────────────────────────────────────────────────────────────────
// Espelha a mensagem no chat do painel (a aba Mensagens), pra loja atender tudo
// num lugar só — WhatsApp e link da Loja Online na mesma conversa.
//
// Se o cliente já tinha falado pelo link, a mensagem entra NAQUELA conversa,
// não numa nova: duas linhas do mesmo cliente fariam o atendente responder na
// errada e o cliente receber pela metade. O casamento é pelos 8 últimos
// dígitos, porque o WhatsApp entrega o número com e sem o 9 do celular.
async function espelharNoChat(
  supabase: any, empresaId: string, phone: string, texto: string,
  remetente: "cliente" | "loja", bot = false,
  // Localização que veio na mensagem (mig 0238). O WhatsApp manda lat/lng no
  // pininho e a gente jogava fora: virava o texto "📍 Localização" e pronto.
  // Guardada, ela vira o ponto da entrega com um clique no gestor.
  coords: { lat: number; lng: number } | null = null,
  // Foto/áudio já guardados no bucket (mig 0242). A conversa fica pra sempre;
  // o arquivo, 24 horas.
  midia: { path: string; tipo: string; expiraEm: string } | null = null,
) {
  try {
    const digitos = String(phone ?? "").replace(/\D/g, "")
    const chave = digitos.slice(-8)
    if (!empresaId || !chave || !texto) return
    const { data: existente } = await supabase
      .from("mensagens_chat")
      .select("canal, cliente_ref, cliente_nome")
      .eq("empresa_id", empresaId)
      .like("cliente_ref", `%${chave}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    let nome = existente?.cliente_nome ?? null
    if (!nome) {
      const { data: cli } = await supabase
        .from("clientes").select("nome")
        .eq("empresa_id", empresaId)
        .like("telefone_digitos", `%${chave}`)
        .limit(1).maybeSingle()
      nome = cli?.nome ?? null
    }
    await supabase.from("mensagens_chat").insert({
      empresa_id: empresaId,
      canal: existente?.canal ?? "whatsapp",
      cliente_ref: existente?.cliente_ref ?? digitos,
      cliente_nome: nome,
      remetente,
      texto,
      // Fala do robô entra como da loja (é o lado direito da conversa), mas
      // marcada: quem atende precisa saber o que já foi respondido por ele.
      bot,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      midia_path:      midia?.path ?? null,
      midia_tipo:      midia?.tipo ?? null,
      midia_expira_em: midia?.expiraEm ?? null,
    })
  } catch (_e) {
    // O espelho é bônus: se falhar, o atendimento pelo WhatsApp segue igual.
  }
}

// O que guardar da mensagem quando o robô está desligado: o texto, quando é
// texto; uma marca curta quando é áudio, foto ou figurinha. O suficiente pra
// loja ver na tela que o cliente chamou e do que se trata.
function textoParaRegistro(msg: any): string {
  const t = msg?.messageType
  if (t === "conversation" || t === "extendedTextMessage") {
    return String(msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "").trim()
  }
  if (t === "pttMessage" || t === "audioMessage") return "🎤 Áudio"
  if (t === "imageMessage") {
    const cap = String(msg.message?.imageMessage?.caption ?? "").trim()
    return cap ? `📷 Foto — ${cap}` : "📷 Foto"
  }
  if (t === "documentMessage") return "📄 Documento"
  if (t === "locationMessage" || t === "liveLocationMessage") return "📍 Localização"
  if (t === "stickerMessage") return "🙂 Figurinha"
  if (t === "videoMessage") return "🎬 Vídeo"
  return ""
}


// Localização que o cliente mandou pelo pininho do WhatsApp (mig 0238).
// deno-lint-ignore-next-line no-explicit-any
function coordsDaMensagem(msg: any): { lat: number; lng: number } | null {
  // "Localização atual" e "localização em tempo real" são a mesma coisa pra
  // gente: quem apertou a segunda por engano não pode ficar sem resposta — o
  // endereço dele está ali do mesmo jeito.
  const loc = msg?.message?.locationMessage ?? msg?.message?.liveLocationMessage
  const lat = Number(loc?.degreesLatitude)
  const lng = Number(loc?.degreesLongitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat === 0 && lng === 0) return null
  return { lat, lng }
}

// A loja respondeu esse número na mão, pelo WhatsApp do celular dela. O robô
// sai de cena por umas horas e a resposta entra na conversa do gestor — senão
// quem abre a tela depois não vê o que o dono já respondeu.
// deno-lint-ignore-next-line no-explicit-any
async function lojaAssumiu(supabase: any, instanceName: string, msg: any) {
  try {
    const phone = String(msg.key?.remoteJid ?? "").replace("@s.whatsapp.net", "").replace(/\D/g, "")
    const texto = textoParaRegistro(msg).trim()
    if (!phone || !texto) return

    const { data: cfg } = await supabase.from("whatsapp_config")
      .select("empresa_id").eq("instance_name", instanceName).eq("ativo", true).maybeSingle()
    if (!cfg?.empresa_id) return

    // Foi o próprio sistema quem mandou? Tudo que sai daqui fica guardado como
    // assistant — se o texto bate com uma das últimas, o eco é nosso e não tem
    // gente nenhuma assumindo conversa.
    const dezMin = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const { data: nossas } = await supabase.from("whatsapp_conversas")
      .select("content").eq("empresa_id", cfg.empresa_id as string)
      .like("phone", `%${phone.slice(-8)}`).eq("role", "assistant")
      .gte("created_at", dezMin).limit(20)
    const daMaquina = (Array.isArray(nossas) ? nossas : [])
      .some((m: Record<string, unknown>) => String(m.content ?? "").trim() === texto)
    if (daMaquina) return

    await pausarPorAtendimentoHumano(supabase, cfg.empresa_id as string, phone)
    await supabase.from("whatsapp_conversas").insert({
      empresa_id: cfg.empresa_id as string, phone, role: "assistant", content: texto, origem: "loja",
    })

    // A conversa também tem que APARECER NO GESTOR, não só no Portal.
    //
    // São duas tabelas: o Portal lê whatsapp_conversas (acima) e o gestor de
    // pedidos lê mensagens_chat — e lá a conversa de WhatsApp só entra se a
    // LOJA tiver falado nela. A resposta dada no celular do dono não passava
    // por aqui, então do lado do gestor a loja nunca tinha falado e o número
    // não existia. Foi o que a CDBom viu em 09/09/2026: a conversa inteira no
    // Portal e nada no gestor, que é onde dá pra montar o pedido junto.
    await espelharNoChat(supabase, cfg.empresa_id as string, phone, texto, "loja")
    // Já respondido no celular: não pode entrar no gestor como não lida, senão
    // a campainha toca por conversa que o dono acabou de atender.
    await supabase.from("mensagens_chat").update({ lida: true })
      .eq("empresa_id", cfg.empresa_id as string)
      .eq("remetente", "cliente")
      .eq("lida", false)
      .like("cliente_ref", `%${phone.slice(-8)}`)
  } catch (e) {
    console.error("[fromMe] falhou:", e)
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const url    = new URL(req.url)
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  try {
    const payload = await req.json()
    if (payload.event !== "messages.upsert") return new Response("ok", { headers: corsHeaders })

    const msg = payload.data
    const coordsMsg = coordsDaMensagem(msg)
    if (!msg) return new Response("ok", { headers: corsHeaders })
    if (msg.key?.remoteJid?.endsWith("@g.us")) return new Response("ok", { headers: corsHeaders })

    const instanceName: string = payload.instance ?? ""
    if (!instanceName) return new Response("ok", { headers: corsHeaders })

    // ── Mensagem VELHA não é atendida ──────────────────────────────────────
    // Quando o Evolution reinicia, ele ressincroniza a conversa e dispara
    // messages.upsert de mensagens antigas. Sem essa trava o robô responde
    // gente que falou dias atrás: em 19/08/2026, depois do restart, 360
    // mensagens antigas viraram 73 respostas para 21 clientes da Zebu — o
    // lojista viu como "disparo" pros clientes dele.
    {
      const ts = msg.messageTimestamp
      let seg = Number(typeof ts === "object" && ts !== null ? (ts.low ?? 0) : (ts ?? 0))
      if (seg > 1e12) seg = seg / 1000            // veio em milissegundos
      const idadeSeg = seg > 0 ? (Date.now() / 1000) - seg : 0
      if (idadeSeg > 600) {
        console.log("[webhook] mensagem antiga ignorada:", Math.round(idadeSeg / 60), "min", instanceName)
        return new Response("ok", { headers: corsHeaders })
      }
    }

    // ── A LOJA ASSUMIU A CONVERSA ──────────────────────────────────────────
    // Mensagem que saiu do número da loja. Até aqui isso era jogado fora, e o
    // robô continuava respondendo por cima do dono — que é o jeito mais rápido
    // de o lojista desligar tudo. Agora o robô cala nesse número por 12 horas.
    if (msg.key?.fromMe) {
      await lojaAssumiu(supabase, instanceName, msg)
      return new Response("ok", { headers: corsHeaders })
    }

    const phoneEarly = msg.key.remoteJid.replace("@s.whatsapp.net", "").replace(/\D/g, "")
    const isTest = url.searchParams.get("test") === "true"
      || req.headers.get("x-bot-test") === "1"
      || payload._test === true
      || phoneEarly === "5500000000001"
    // Testar a IA de uma loja que ainda não ligou (ou fora do horário) sem abrir
    // nada pro cliente de verdade: só vale junto com o modo teste.
    const forcarIa = isTest && url.searchParams.get("forcar_ia") === "true"
    // "Devolver pro robô" com mensagens do cliente sem resposta (robo-retomar).
    const retomada = payload._retomada === true

    // Vendedor IA desligado: cala a boca AQUI, antes de qualquer coisa.
    // A checagem ficava lá embaixo, depois do tratamento de áudio/imagem — e
    // essas partes já respondiam ("não consegui ouvir o áudio") com o bot
    // desligado. Pro dono, isso é o bot ignorando o interruptor.
    {
      const { data: liga } = await supabase
        .from("whatsapp_config")
        .select("empresa_id, ia_ativo, resposta_link_ativo, resposta_link_texto, empresas(nome, slug, agendamento_ativo, delivery_ativo, delivery_fechado_por, feriados_fecha, horarios_funcionamento, horario_abertura, horario_fechamento, endereco, numero, bairro, cidade, estado, latitude, longitude, raio_entrega_km, aceita_entrega, aceita_retirada, taxa_entrega, taxas_entrega_bairro, taxas_entrega_km, tempo_entrega_min, tempo_entrega_max)")
        .eq("instance_name", instanceName)
        .eq("ativo", true)
        .maybeSingle()
      if (!liga?.ia_ativo && !forcarIa) {
        // Robô desligado não é caixa postal fechada. A mensagem do cliente era
        // jogada fora aqui, e a loja nunca ficava sabendo que alguém chamou —
        // nem depois, olhando a tela. Guardar é tudo o que fazemos: responder
        // continua sendo só do robô, e o atendente responde pelo gestor.
        //
        // Áudio e foto entram como marca ("🎤 Áudio"), sem transcrever: gastar
        // Whisper com o robô desligado é cobrar da loja um trabalho que ninguém
        // pediu. Quem for atender abre o WhatsApp e ouve.
        const conteudo = textoParaRegistro(msg)
        if (liga?.empresa_id && conteudo && !isTest) {
          await supabase.from("whatsapp_conversas").insert({
            empresa_id: liga.empresa_id, phone: phoneEarly, role: "user", content: conteudo,
          })
          // A foto e o áudio SÃO guardados aqui (mig 0242) — e este é o caso que
          // mais importa: robô desligado quer dizer que tem gente atendendo à
          // mão, e é essa pessoa que precisa abrir a foto do comprovante ou
          // ouvir o áudio do pedido. Continua sem transcrever: Whisper com o
          // robô desligado é cobrar da loja um trabalho que ninguém pediu.
          let midiaOff = null
          const tipoOff = msg?.messageType
          if (tipoOff === "imageMessage" || tipoOff === "audioMessage" || tipoOff === "pttMessage") {
            const m = await getMediaBase64(instanceName, msg)
            if (m?.base64) {
              midiaOff = await guardarMidiaDoChat(
                supabase, liga.empresa_id, m.base64, m.mimetype?.split(";")?.[0] ?? "application/octet-stream")
            }
          }
          await espelharNoChat(supabase, liga.empresa_id, phoneEarly, conteudo, "cliente", false, coordsMsg, midiaOff)

          // Resposta automática com o LINK do cardápio (mig 0226). Sem IA, sem
          // crédito: o cardápio é que sabe preço, taxa, cashback e agendamento —
          // e ele está sempre atualizado, coisa que nenhum prompt fica.
          const respondeu = await responderSemIA({
            supabase, cfg: liga as Record<string, unknown>, phone: phoneEarly, mensagem: conteudo,
            enviar: (texto: string) => fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
              body: JSON.stringify({ number: phoneEarly, text: texto }),
            }),
            espelhar: (texto: string) =>
              espelharNoChat(supabase, liga.empresa_id, phoneEarly, texto, "loja", true),
          })
          if (respondeu) console.log("[link] resposta automatica enviada", phoneEarly)
        }
        return new Response("ok", { headers: corsHeaders })
      }
    }

    let text = ""
    let imageBase64: string | null = null
    let imageMimetype = "image/jpeg"
    // O arquivo cru, pra subir no bucket assim que a empresa for conhecida
    // (mig 0242). Não dá pra subir antes: o caminho no bucket começa pelo
    // empresa_id, que é o que separa a foto de uma loja da foto da outra.
    let midiaCrua: { base64: string; mimetype: string } | null = null

    if (msg.messageType === "conversation" || msg.messageType === "extendedTextMessage") {
      text = (msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "").trim()
      if (!text) return new Response("ok", { headers: corsHeaders })

    } else if (msg.messageType === "pttMessage" || msg.messageType === "audioMessage") {
      const media = await getMediaBase64(instanceName, msg)
      if (media?.base64) {
        // O mesmo download serve pras duas coisas: transcrever pro robô e
        // guardar pra loja ouvir no gestor.
        midiaCrua = { base64: media.base64, mimetype: media.mimetype }
        const transcricao = await transcribeAudio(media.base64, media.mimetype)
        if (transcricao?.trim()) {
          text = transcricao.trim()
          console.log("[Áudio] transcrito:", text)
        } else {
          await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
            body: JSON.stringify({ number: phoneEarly, text: "Oi! 😊 Não consegui entender o áudio. Pode escrever por texto?" }),
          }).catch(() => {})
          return new Response("ok", { headers: corsHeaders })
        }
      } else {
        await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({ number: phoneEarly, text: "Oi! 😊 Não consegui ouvir o áudio. Pode escrever por texto?" }),
        }).catch(() => {})
        return new Response("ok", { headers: corsHeaders })
      }

    } else if (coordsMsg) {
      // LOCALIZAÇÃO (mig 0239). Caía no `else` lá embaixo e o cérebro devolvia
      // "ok" sem ler nada: o pino do cliente morria na porta. O texto aqui é só
      // pro histórico da conversa — quem trata o ponto é o curto-circuito mais
      // adiante, antes da IA.
      text = "📍 Localização"

    } else if (msg.messageType === "imageMessage") {
      const caption = (msg.message?.imageMessage?.caption ?? "").trim()
      const media = await getMediaBase64(instanceName, msg)
      if (media?.base64) {
        imageBase64 = media.base64
        imageMimetype = media.mimetype?.split(";")?.[0] ?? "image/jpeg"
        midiaCrua = { base64: media.base64, mimetype: imageMimetype }
      }
      text = caption || "[imagem]"

    } else {
      return new Response("ok", { headers: corsHeaders })
    }

    const configRes = await supabase
      .from("whatsapp_config")
      .select("empresa_id, ia_ativo, ia_instrucoes, admin_phone, empresas(id, nome, slug, descricao, email_contato, chave_pix, pix_nome, taxa_entrega, pedido_minimo, taxas_entrega_km, taxas_entrega_bairro, raio_entrega_km, latitude, longitude, aceita_delivery, endereco, numero, cidade, estado, cep, horario_abertura, horario_fechamento, horarios_funcionamento, feriados_fecha, indicador_profile_id, mp_conectado, formas_pagamento, delivery_ativo, delivery_fechado_por)")
      .eq("instance_name", instanceName)
      .eq("ativo", true)
      .single()

    const config = configRes.data
    if (!config?.ia_ativo && !forcarIa) return new Response("ok", { headers: corsHeaders })

    const empresa        = (config.empresas as any) ?? {}
    const empresaId      = config.empresa_id
    // O arquivo já foi baixado lá em cima; aqui ele finalmente tem dono e pode
    // ir pro bucket (mig 0242). Falhar aqui não derruba nada: a mensagem entra
    // na conversa do mesmo jeito, só sem o anexo.
    const midiaChat = midiaCrua
      ? await guardarMidiaDoChat(supabase, empresaId, midiaCrua.base64, midiaCrua.mimetype)
      // Na Cloud API quem baixa é o whatsapp-cloud (a Meta entrega o arquivo por
      // um id, e o prazo é curto). Ele já guardou e manda o anexo pronto.
      : (payload?._midia ?? null)
    const empresaNome    = empresa.nome ?? "Loja"
    const empresaSlug    = empresa.slug ?? ""
    const taxaEntrega    = Number(empresa.taxa_entrega ?? 0)
    const aceitaDelivery      = empresa.aceita_delivery ?? false
    // PIX no bot: só oferecido se a loja conectou o Mercado Pago dela (dinheiro cai na conta da loja,
    // pedido só vai pro painel após pagamento confirmado). Loja sem MP conectado: nada muda, segue dinheiro/cartão.
    const mpConectado         = empresa.mp_conectado === true
    const pagamentos          = pagamentosDaLoja(empresa)
    const pgtoOpcoes          = opcoesDePagamento(pagamentos)
    const iaInstrucoes        = (config.ia_instrucoes ?? "").trim()
    const adminPhone          = (config.admin_phone ?? "").replace(/\D/g, "")
    const indicadorProfileId  = empresa.indicador_profile_id ?? null

    const empresaDescricao = empresa.descricao ?? ""
    const empresaEndereco  = [empresa.endereco, empresa.numero, empresa.cidade, empresa.estado].filter(Boolean).join(", ")
    const empresaHorario   = empresa.horario_abertura && empresa.horario_fechamento
      ? `${empresa.horario_abertura} às ${empresa.horario_fechamento}`
      : empresa.horario_abertura ?? ""

    const catalogoUrl = empresaSlug
      ? `https://lojaonline.fwcinter.com/${empresaSlug}`
      : "https://lojaonline.fwcinter.com"

    const phone      = msg.key.remoteJid.replace("@s.whatsapp.net", "").replace(/\D/g, "")

    // Conversa pausada pelo admin para este número? → o robô não responde.
    {
      // Casa pelos 8 últimos dígitos: o mesmo número chega com e sem o 9, e
      // pausar uma forma tem que calar o robô nas duas.
      if (await roboPausado(supabase, empresaId, phone)) {
        // Pausado = tem gente atendendo à mão. Antes a mensagem era descartada
        // aqui — justamente na conversa em que alguém está esperando por ela.
        if (text && !isTest && !retomada) {
          await supabase.from("whatsapp_conversas").insert({
            empresa_id: empresaId, phone, role: "user", content: text,
          })
        }
        if (text && !retomada) await espelharNoChat(supabase, empresaId, phone, text, "cliente", false, coordsMsg, midiaChat)
        return new Response("ok", { headers: corsHeaders })
      }
    }

    const phoneLocal = phone.replace(/^55/, "")
    const phoneLocalWith9 = phoneLocal.length === 10
      ? `${phoneLocal.slice(0, 2)}9${phoneLocal.slice(2)}`
      : phoneLocal
    // Variante SEM o 9 (BR): se veio com 9 (11 díg, 3º dígito 9), gera a versão de 10 díg.
    // Garante achar o cadastro salvo sem o 9 (Evolution às vezes entrega com, às vezes sem).
    const phoneLocalNo9 = phoneLocal.length === 11 && phoneLocal[2] === "9"
      ? `${phoneLocal.slice(0, 2)}${phoneLocal.slice(3)}`
      : phoneLocal

    // ── CHAMADO ABERTO: tem gente da loja indo responder ────────────────────
    // O robô cala e guarda a mensagem. Falar por cima de quem foi chamado é
    // exatamente o que o cliente não quer quando pede uma pessoa.
    if (await chamadoAberto(supabase, empresaId, phone)) {
      console.log("[chamado] aberto, robô calado:", phone)
      if (!retomada) {
        await supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "user", content: text })
        await espelharNoChat(supabase, empresaId, phone, text, "cliente", false, coordsMsg, midiaChat)
      }
      if (isTest) {
        return new Response(JSON.stringify({ ok: true, resposta: "(robô calado — chamado aberto)" }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      }
      return new Response("ok", { headers: corsHeaders })
    }

    // ── O CLIENTE PEDIU UMA PESSOA ──────────────────────────────────────────
    // Vem antes da IA de propósito: não gasta crédito pra dizer "vou chamar", e
    // não corre o risco de o modelo tentar resolver sozinho o que já foi pedido
    // a uma pessoa.
    if (PEDE_HUMANO.test(text)) {
      if (!retomada) {
        await supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "user", content: text })
        await espelharNoChat(supabase, empresaId, phone, text, "cliente", false, coordsMsg, midiaChat)
      }
      await abrirChamado(supabase, empresaId, phone, text)
      const avisa = "Já chamei alguém aqui da loja pra falar com você. 🙌 Só um instante!"
      await supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "assistant", content: avisa })
      await espelharNoChat(supabase, empresaId, phone, avisa, "loja", true)
      console.log("[chamado] cliente pediu atendente:", phone)
      if (isTest) {
        return new Response(JSON.stringify({ ok: true, resposta: avisa }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      }
      await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: phone, text: avisa }),
      }).catch(e => console.error("[sendText] erro:", e))
      return new Response("ok", { headers: corsHeaders })
    }

    const [creditRes, minhaMsgRes] = await Promise.all([
      supabase.from("empresas").select("whatsapp_creditos, credito_alerta_minimo, credito_alerta_enviado, credito_alerta_numeros").eq("id", empresaId).single(),
      // Retomada (robo-retomar): as mensagens já estão gravadas desde que
      // chegaram com o robô pausado. Gravar de novo duplicaria a conversa — e
      // sem created_at a espera de rajada lá embaixo também não roda.
      retomada
        ? Promise.resolve({ data: null })
        : supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "user", content: text }).select("created_at").single(),
      // Espelho na aba Mensagens do gestor: é lá que a loja responde quando o
      // robô chama, e a conversa precisa estar inteira na tela pra pessoa saber
      // o que já foi dito.
      retomada
        ? Promise.resolve()
        : espelharNoChat(supabase, empresaId, phone, text, "cliente", false, coordsMsg, midiaChat),
    ])
    if (!creditRes.data || creditRes.data.whatsapp_creditos <= 0) return new Response("ok", { headers: corsHeaders })

    // ── RAJADA: "quero sorvete" / "100 picolé" / "e caixa de açaí" ─────────────
    // Cada mensagem chegava numa chamada própria, e o cliente recebia três
    // respostas — três "Oi, seja bem-vindo", nenhuma anotando nada (teste
    // CDBom, 13/09). Agora a chamada espera um pouco: se entrou mensagem mais
    // nova do mesmo cliente, ela sai calada e quem responde é a última, que já
    // lê as três juntas no histórico (mensagens seguidas do cliente viram uma).
    // Foto e localização não esperam: o anexo só existe na chamada que o trouxe.
    if (minhaMsgRes?.data?.created_at && !imageBase64 && !coordsMsg) {
      await new Promise(r => setTimeout(r, ESPERA_RAJADA_MS))
      const { data: maisNova } = await supabase.from("whatsapp_conversas")
        .select("created_at")
        .eq("empresa_id", empresaId).eq("phone", phone).eq("role", "user")
        .gt("created_at", minhaMsgRes.data.created_at)
        .limit(1)
      if (maisNova?.length) {
        console.log(`[rajada] "${text.slice(0, 40)}" — chegou mensagem mais nova, quem responde é ela`)
        // Sem `resposta` de propósito: o whatsapp-cloud chama este cérebro no
        // modo teste e manda ao cliente qualquer texto que voltar aqui.
        return new Response(JSON.stringify({ ok: true, agrupada: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      }
    }

    // ── Alerta de crédito baixo pro dono (uma vez só; reseta após recarregar) ──
    {
      const saldo = Number(creditRes.data.whatsapp_creditos ?? 0)
      const alertaMin = Number(creditRes.data.credito_alerta_minimo ?? 0)
      const jaAvisou = creditRes.data.credito_alerta_enviado === true
      // Destinatários (nome + telefone). Sem lista, cai no telefone do admin.
      const listaNums = Array.isArray(creditRes.data.credito_alerta_numeros) ? creditRes.data.credito_alerta_numeros : []
      const destinos = listaNums.length ? listaNums : (adminPhone ? [{ nome: "", telefone: adminPhone }] : [])
      const paraZap = (tel: any) => { const d = String(tel ?? "").replace(/\D/g, ""); return d ? (d.startsWith("55") ? d : "55" + d) : "" }
      if (alertaMin > 0 && saldo > 0 && saldo <= alertaMin && !jaAvisou && destinos.length) {
        for (const dest of destinos as any[]) {
          const num = paraZap(dest?.telefone)
          if (!num) continue
          const ola = dest?.nome ? `Oi, *${dest.nome}*! ` : ""
          const msg = `${ola}⚠️ *${empresaNome}* — créditos do robô acabando!\n\n` +
            `Saldo atual: *${saldo}* crédito(s).\n\n` +
            `Recarregue no sistema em *WhatsApp → Créditos Bot* pra o robô não parar de responder os clientes. 🤖`
          fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
            method: "POST", headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
            body: JSON.stringify({ number: num, text: msg }),
          }).catch(e => console.error("[CreditoBaixo] erro ao avisar:", e))
        }
        await supabase.from("empresas").update({ credito_alerta_enviado: true }).eq("id", empresaId)
      } else if (jaAvisou && saldo > alertaMin) {
        // Recarregou acima do mínimo → volta a poder alertar no próximo episódio.
        await supabase.from("empresas").update({ credito_alerta_enviado: false }).eq("id", empresaId)
      }
    }

    // Horário do dia (em texto) e o relógio de agora — o prompt da IA usa os dois
    // lá embaixo. Antes o prompt levava só horario_abertura/fechamento (o campo
    // legado, que ninguém mais edita): o lojista mexia na grade da semana e a IA
    // seguia recitando o horário velho, e às vezes dizia "estamos fechados" com a
    // loja aberta, porque não sabia nem que horas eram.
    let horarioLojaTexto = ""
    let agoraTexto = ""

    // Verifica horário de funcionamento — responde "fechado" e retorna sem chamar Claude.
    // Fonte: grade semanal nova (horarios_funcionamento). Sem grade, cai no horário único legado.
    {
      const DIAS_SEM = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"]
      const toMinH = (t: string) => { const [h, m] = String(t).slice(0, 5).split(":").map(Number); return (h || 0) * 60 + (m || 0) }
      const horaBR      = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Fortaleza" }))
      const minutoAtual = horaBR.getHours() * 60 + horaBR.getMinutes()
      const dow         = horaBR.getDay()

      const grade = Array.isArray(empresa.horarios_funcionamento) && empresa.horarios_funcionamento.length === 7
        ? empresa.horarios_funcionamento : null

      let lojaFechada = false
      let horarioTexto = ""

      if (grade) {
        // A grade sozinha não sabe de feriado nem de folga marcada na mão. Sem
        // isto o robô prometia "voltamos segunda às 08:00" numa segunda que a
        // loja já tinha fechado no calendário (mesma regra da Loja Online).
        const excecoes = await carregarExcecoes(supabase, empresaId)
        const doDia = comoFicaNoDia(hojeNaLoja(), empresa as Record<string, unknown>, excecoes)
        const periodosHoje = (doDia.aberto ? doDia.periodos : []).filter(p => p?.i && p?.f)
        lojaFechada = !periodosHoje.some(p => {
          const a = toMinH(p.i), b = toMinH(p.f)
          return a <= b ? (minutoAtual >= a && minutoAtual < b) : (minutoAtual >= a || minutoAtual < b)
        })
        if (periodosHoje.length) {
          horarioTexto = "Hoje atendemos das " + periodosHoje.map(p => `*${p.i}* às *${p.f}*`).join(" e ")
        } else {
          for (let k = 1; k <= 7; k++) {
            const data = daquiADias(k)
            const nd = comoFicaNoDia(data, empresa as Record<string, unknown>, excecoes)
            const ps = (nd.aberto ? nd.periodos : []).filter(p => p?.i && p?.f)
            if (!ps.length) continue
            const [yy, mm, dd2] = data.split("-").map(Number)
            horarioTexto = `Voltamos ${DIAS_SEM[new Date(yy, mm - 1, dd2).getDay()]} às *${ps[0].i}*`
            break
          }
        }
      } else if (empresa.horario_abertura && empresa.horario_fechamento) {
        const [aH, aM] = empresa.horario_abertura.slice(0, 5).split(":").map(Number)
        const [fH, fM] = empresa.horario_fechamento.slice(0, 5).split(":").map(Number)
        lojaFechada = minutoAtual < (aH * 60 + aM) || minutoAtual >= (fH * 60 + fM)
        horarioTexto = `Horário de atendimento: *${empresa.horario_abertura.slice(0, 5)}* às *${empresa.horario_fechamento.slice(0, 5)}*`
      }

      horarioLojaTexto = horarioTexto
      agoraTexto = `${DIAS_SEM[dow]}, ${String(horaBR.getHours()).padStart(2, "0")}:${String(horaBR.getMinutes()).padStart(2, "0")}`

      // O BOTÃO VERMELHO DO GESTOR ("Loja fechada"). A Loja Online e o robô sem
      // IA já param nele; o de IA olhava só a grade e continuava vendendo com a
      // loja fechada na tela — pedido caindo num painel que ninguém olha.
      // Fechado por "horario" é o painel se fechando sozinho no fim do
      // expediente: aí quem manda é a grade (mesma regra do respostaSemIA).
      const fechadaNoBotao = empresa.delivery_ativo === false && empresa.delivery_fechado_por !== "horario"
      if (fechadaNoBotao) {
        lojaFechada = true
        // Sem prometer horário: quem fechou na mão volta quando quiser.
        horarioTexto = ""
      }

      if (lojaFechada && !forcarIa) {
        // Só avisa uma vez — se a última mensagem do bot já foi "fechado", ignora
        const { data: ultimaBotMsg } = await supabase
          .from("whatsapp_conversas")
          .select("content")
          .eq("empresa_id", empresaId).eq("phone", phone).eq("role", "assistant")
          .order("created_at", { ascending: false })
          .limit(1).maybeSingle()

        const jaAvisou = ultimaBotMsg?.content?.includes("Estamos fechados")
        if (!jaAvisou) {
          // Sem horário (fechou no botão do gestor): a linha sai inteira, senão
          // vira "Confira nosso cardápio" e logo abaixo "já pode ver o cardápio".
          const msgFechado = `😴 Estamos fechados no momento!\n\n${horarioTexto ? `${horarioTexto}.\n\n` : ""}Mas você já pode ver nosso cardápio e se planejar! 😊\n👉 ${catalogoUrl}`
          await supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "assistant", content: msgFechado })
          // Anota pra mandar "Já abrimos" quando a loja abrir HOJE (mig 0267,
          // worker aviso-abertura). Cada "fechado" novo reabre o aviso: quem
          // chamou no intervalo do almoço recebe de novo quando voltar. O teste
          // pela URL não entra — ele usa número de verdade.
          if (url.searchParams.get("test") !== "true") {
            await supabase.from("aviso_abertura").upsert({
              empresa_id: empresaId, phone, dia: hojeNaLoja(),
              criado_em: new Date().toISOString(),
              status: "pendente", motivo: null, enviado_em: null,
            }, { onConflict: "empresa_id,phone,dia" }).then(() => {}, () => {})
          }
          if (!isTest) {
            await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
              body: JSON.stringify({ number: phone, text: msgFechado }),
            }).catch(() => {})
          }
        }
        return new Response(JSON.stringify({ ok: true, fechado: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      }
    }

    const [historicoRes, produtosRes, carrinhoRes, clienteRes] = await Promise.all([
      supabase.from("whatsapp_conversas")
        // `origem` diz quem escreveu do lado da loja: 'loja' é gente, o resto é
        // o robô. Serve pra busca de produto enxergar o nome CERTO que o
        // atendente digitou quando assumiu a conversa.
        .select("role, content, origem, created_at")
        .eq("empresa_id", empresaId)
        .eq("phone", phone)
        .order("created_at", { ascending: false })
        .limit(30),
      // Até MENU_INTEIRO_ATE itens vem o cardápio todo; passou disso, esta
      // consulta volta vazia (head) e quem monta o menu é catalogoRelevante.
      supabase.from("produtos")
        .select(PRODUTO_COLUNAS, { count: "exact" })
        .eq("empresa_id", empresaId)
        .eq("ativo", true)
        // Pausado no delivery some da Loja Online e da busca do catálogo grande
        // (buscar_produto_nome); aqui o robô ainda oferecia.
        .eq("disponivel_delivery", true)
        .is("arquivado_em", null)
        .order("nome")
        .limit(MENU_INTEIRO_ATE),
      supabase.from("whatsapp_carrinho")
        .select("items, cliente_id, endereco_rua, endereco_numero, endereco_bairro, endereco_cidade, endereco_estado, endereco_lat, endereco_lng")
        .eq("empresa_id", empresaId)
        .eq("phone", phone)
        .single(),
      supabase.from("clientes")
        .select("id, nome, email, cep, numero, endereco, bairro, cidade, estado, telefone, created_at, origem, endereco_lat, endereco_lng, endereco_pin_manual")
        .eq("empresa_id", empresaId)
        .in("telefone", [...new Set([phone, phoneLocal, `0${phoneLocal}`, `55${phoneLocal}`, phoneLocalWith9, `55${phoneLocalWith9}`, phoneLocalNo9, `55${phoneLocalNo9}`])])
        .limit(1)
        .maybeSingle(),
    ])

    const mensagensRaw = (historicoRes.data ?? []).reverse()
    // Cliente que responde ENQUANTO o robô ainda responde a anterior: a resposta
    // velha é gravada depois da mensagem nova, e o histórico terminava na fala
    // do robô. O modelo entendia que já tinha respondido e devolvia vazio
    // ("Desculpe, não entendi bem" — teste 13/09). A mensagem que esta chamada
    // está respondendo vai pro fim, que é o lugar dela.
    {
      const minhaData = minhaMsgRes?.data?.created_at
      const idx = minhaData ? mensagensRaw.findIndex((m: any) => m.role === "user" && m.created_at === minhaData) : -1
      if (idx !== -1 && mensagensRaw.slice(idx + 1).some((m: any) => m.role === "assistant")) {
        const [minha] = mensagensRaw.splice(idx, 1)
        mensagensRaw.push(minha)
        console.log("[rajada] resposta anterior chegou depois desta mensagem — histórico reordenado")
      }
    }
    // Mescla mensagens consecutivas do mesmo role (evita 400 da API do Claude)
    const mensagens = mensagensRaw.reduce((acc: any[], m: any) => {
      const last = acc[acc.length - 1]
      if (last && last.role === m.role) {
        last.content = (last.content ?? "") + "\n" + (m.content ?? "")
        return acc
      }
      acc.push({ role: m.role, content: m.content })
      return acc
    }, [])
    // ── Escolha que ficou pendurada ────────────────────────────────────────
    // A última fala do robô foi da REDE (conferirEscolhas), que SUBSTITUIU a do
    // modelo. Ele não tem memória da ação que tentou emitir — só lê a cobrança
    // da borda. Aí o cliente responde "borda de catupiry", o modelo acha que
    // não tem nada a fazer, diz "Perfeito!" e a pizza nunca entra na sacola
    // (testado 25/09). Aqui a pendência é dita com todas as letras, no único
    // turno em que ela importa.
    // A última fala do robô, pra saber depois se ele estava cobrando uma escolha
    // obrigatória quando o cliente respondeu.
    let roboPediuEscolha = false
    {
      const ultimaFala = mensagens[mensagens.length - 1]
      const ultimoRobo = [...mensagens].reverse().find((m: any) => m.role === "assistant")
      const falaRobo = String(ultimoRobo?.content ?? "")
      const pendente = falaRobo.startsWith(AVISO_ESCOLHA_PREFIXO)
      // Pela rede (texto fixo) ou pelo próprio modelo (ele lista as opções com
      // o preço do adicional). Os dois terminam no mesmo lugar: um item pela
      // metade, fora da sacola, esperando uma palavra do cliente.
      // "Qual voce quer — Calabresa: Acebolada, com Cheddar..." tambem conta:
      // se o robo ja abriu a familia de sabor, a proxima mensagem do cliente e
      // a resposta dela, e perguntar de novo vira roda-viva.
      roboPediuEscolha = pendente
        || /falta escolher|\(escolha \d|\(\+R\$|qual (a |sua )?borda/i.test(falaRobo)
        || /^Só pra eu anotar certinho|^Antes de anotar, preciso acertar uns sabores|qual você (quer|prefere)/i.test(falaRobo)
      if (pendente && ultimaFala?.role === "user") {
        ultimaFala.content = `${ultimaFala.content}\n\n[SISTEMA — não é o cliente] O item que você tentou anotar na mensagem anterior NÃO foi salvo: faltava uma escolha obrigatória, e a lista acima mostra o que ele já tinha. A resposta do cliente completa ESSE item. Emita atualizar_carrinho com ele inteiro (produto + as escolhas que já estavam + a que o cliente acabou de dar), junto com o que já estava no carrinho.`
        console.log("[Escolha] pendência da rede reinjetada no contexto")
      }
    }
    // Remove da listagem os produtos cuja categoria está FORA do horário de venda
    // agora (horário de Brasília). Categoria sem horário = sempre disponível.
    // Só filtra o cardápio — não muda mais nada do fluxo do bot. Como toda a
    // montagem (lista + complementos + preços) usa `produtos`, o filtro cobre tudo.
    const { data: catsHorario } = await supabase
      .from("categorias")
      .select("nome, hora_inicio, hora_fim, dias_semana")
      .eq("empresa_id", empresaId)
    const nowBRT = new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit" })
    const toMinBRT = (t: string) => { const [h, m] = String(t).slice(0, 5).split(":").map(Number); return h * 60 + m }
    const nowMinBRT = toMinBRT(nowBRT)
    // Dia da semana em Brasília, 0 = domingo (o mesmo getDay() da Loja Online).
    const diaBRT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      .indexOf(new Date().toLocaleDateString("en-US", { timeZone: "America/Fortaleza", weekday: "short" }))
    const catForaHorario = new Set<string>()
    for (const c of ((catsHorario ?? []) as any[])) {
      // Categoria só de alguns dias ("Promoção de Quarta"): a Loja Online já
      // escondia fora do dia; o robô vendia a promoção a semana inteira.
      if (Array.isArray(c.dias_semana) && c.dias_semana.length > 0 && !c.dias_semana.map(Number).includes(diaBRT)) {
        catForaHorario.add(c.nome)
        continue
      }
      if (!c.hora_inicio || !c.hora_fim) continue
      const a = toMinBRT(c.hora_inicio), b = toMinBRT(c.hora_fim)
      const disp = a <= b ? (nowMinBRT >= a && nowMinBRT < b) : (nowMinBRT >= a || nowMinBRT < b)
      if (!disp) catForaHorario.add(c.nome)
    }
    // Catálogo grande: em vez do começo do alfabeto, o que tem a ver com a
    // conversa. Usa as últimas falas do CLIENTE (não as do robô) e o carrinho.
    const totalProdutos = produtosRes.count ?? (produtosRes.data ?? []).length
    let produtosBase = (produtosRes.data ?? []) as any[]
    if (totalProdutos > MENU_INTEIRO_ATE) {
      // O que o CLIENTE falou + o que a PESSOA da loja escreveu. O atendente é
      // quem sabe o nome certo do produto ("é a CACHAÇA GALIOTO 1L"), e sem
      // isto o robô voltava da transferência ainda sem enxergar o item.
      const falasCliente = mensagens.filter((m: any) => m.role === "user").slice(-4).reverse().map((m: any) => m.content)
      const falasDaLoja = mensagens.filter((m: any) => m.origem === "loja").slice(-2).reverse().map((m: any) => m.content)
      const falas = [text, ...falasDaLoja, ...falasCliente]
      const idsCarrinho = (carrinhoRes.data?.items ?? [])
        .map((i: any) => i.produto_id ?? i.id).filter(Boolean)
      produtosBase = await catalogoRelevante(supabase, empresaId, falas, idsCarrinho)
      console.log(`[menu] catálogo com ${totalProdutos} itens → ${produtosBase.length} relevantes`)
    }
    const produtos = produtosBase.filter((p: any) => !p.categoria || !catForaHorario.has(p.categoria))

    // ── Preço especial de parceria (cliente + produto) ──
    // Se ESTE cliente tem preço combinado num produto, sobrescreve o preço base só pra ele.
    // Como menu e cálculo usam `produtos.preco_venda`, trocar aqui cobre os dois (mostra e cobra certo).
    const clienteEspId = clienteRes.data?.id
    if (clienteEspId) {
      const { data: precosEsp } = await supabase
        .from("precos_especiais_cliente")
        .select("produto_id, preco")
        .eq("empresa_id", empresaId)
        .eq("cliente_id", clienteEspId)
      if (precosEsp && precosEsp.length) {
        const espMap: Record<string, number> = {}
        for (const pe of precosEsp as any[]) espMap[pe.produto_id] = Number(pe.preco)
        for (const p of produtos) if (espMap[p.id] != null) p.preco_venda = espMap[p.id]
      }
    }

    // ── Complementos ("monte sua quentinha") — só dos produtos que têm grupos ──
    // Texto injetado no prompt para o bot listar categorias + máximo de cada.
    // Mapas de preço (verdade do banco) para recalcular o preço no servidor —
    // NUNCA confiar na conta feita pelo modelo.
    let complementosTexto = ""
    const precoOpcaoMap: Record<string, number> = {}  // nome da opção (minúsculo) → adicional
    const regrasOpcao: RegrasOpcao = {}               // produto → opção → grupo e regra de preço
    const exigencias: Exigencias = {}                 // produto → grupos que o pedido precisa respeitar
    // Sabores de cada produto, pra conferir o que a IA grava (conferirSabores).
    const saboresPorProduto: SaboresPorProduto = {}
    // Produto em vários tamanhos com sabores diferentes (ver saborSemTamanho).
    let familiasTamanho: FamiliaTamanho[] = []
    // Loja com pizza meio a meio (grupo que cobra pelo maior): o roteiro ganha a regra.
    let temMeioAMeio = false
    try {
      const produtoIds = produtos.map((p: any) => p.id)
      if (produtoIds.length) {
        // Lê pela ponte produto↔grupo: mesma categoria pode servir vários produtos,
        // e cada vínculo pode ter min/max próprio (ex.: proteína P=1, M/G=2).
        const { data: vincComp } = await supabase
          .from("produto_complemento_grupos")
          .select("produto_id, ordem, min_override, max_override, complemento_grupos(id, nome, min, max, disponivel, regra_preco, complemento_opcoes(nome, preco_adicional, ordem, disponivel))")
          .in("produto_id", produtoIds)
        if (vincComp && vincComp.length) {
          const porProduto: Record<string, any[]> = {}
          for (const v of vincComp as any[]) {
            const g = v.complemento_grupos
            if (g) {
              const sp = (saboresPorProduto[v.produto_id] ||= { disponiveis: [], pausadas: [] })
              for (const o of (g.complemento_opcoes ?? [])) {
                // Grupo pausado pausa todas as opções dele.
                if (g.disponivel === false || !o.disponivel) sp.pausadas.push(String(o.nome))
                else sp.disponiveis.push(String(o.nome))
              }
            }
            if (!g || g.disponivel === false) continue // grupo pausado: bot não oferece
            if (g.regra_preco === "maior") temMeioAMeio = true
            const gEff = { ...g, min: v.min_override ?? g.min, max: v.max_override ?? g.max, ordem: v.ordem ?? 0 }
            ;(porProduto[v.produto_id] ||= []).push(gEff)
            // Quanto o produto EXIGE de cada grupo. Só entra o grupo em que a
            // escolha muda o preço (borda, sabor de pizza): o sabor de picolé
            // da CDBom é de graça e a loja manda sortido quando ninguém escolhe.
            {
              const ops = (g.complemento_opcoes ?? []).filter((o: any) => o.disponivel)
              if (ops.some((o: any) => Number(o.preco_adicional) > 0)) {
                (exigencias[v.produto_id] ||= []).push({
                  nome: String(g.nome), min: Number(gEff.min) || 0, max: Number(gEff.max) || 0,
                  opcoes: ops.map((o: any) => String(o.nome)),
                })
              }
            }
            for (const o of (g.complemento_opcoes ?? [])) {
              precoOpcaoMap[String(o.nome).trim().toLowerCase()] = Number(o.preco_adicional ?? 0)
              // De qual grupo é a opção e como ele cobra (mig 0120): pizza meio a
              // meio vale o sabor mais caro, a borda soma.
              ;(regrasOpcao[v.produto_id] ||= {})[String(o.nome).trim().toLowerCase()] = {
                grupo: String(g.id ?? g.nome), maior: g.regra_preco === "maior",
                preco: Number(o.preco_adicional ?? 0),
              }
            }
          }
          const nomeDoProduto = (id: string) => produtos.find((p: any) => p.id === id)?.nome ?? ""
          // Opção "opt-out" (Sem X / Não Quero) só serve pra recusar a categoria.
          const soSemOpcao = (nome: string) => /^\s*sem\s|n[ãa]o\s*quero/i.test(String(nome || ""))
          const blocos: string[] = []
          for (const [pid, grupos] of Object.entries(porProduto)) {
            const linhas = (grupos as any[])
              // Categoria que sobrou só com "Sem/Não Quero" (nada real) não entra no cardápio.
              .filter((g: any) => (g.complemento_opcoes ?? []).some((o: any) => o.disponivel && !soSemOpcao(o.nome)))
              .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
              .map((g: any) => {
                const ops = (g.complemento_opcoes ?? [])
                  .filter((o: any) => o.disponivel)
                  .sort((a: any, b: any) => (a.ordem ?? 0) - (b.ordem ?? 0))
                  .map((o: any) => Number(o.preco_adicional) > 0
                    ? `• ${o.nome} (${g.regra_preco === "maior" ? "" : "+"}R$ ${Number(o.preco_adicional).toFixed(2)})`
                    : `• ${o.nome}`)
                  .join("\n")
                const quant = (g.max > 1 ? (g.min === g.max ? `escolha ${g.max}` : `escolha até ${g.max}`) : (g.min > 0 ? "escolha 1" : "opcional"))
                  // Pizza meio a meio: o preço de cada opção é o da pizza inteira
                  // daquele sabor, e vale o MAIS CARO dos escolhidos — não soma.
                  + (g.regra_preco === "maior" ? " — cada sabor é uma metade; o preço é o do sabor MAIS CARO, NÃO soma" : "")
                // Pausado entra à parte: sem isto, "tem de castanha?" virava "não
                // temos esse sabor" — e a loja tem, só acabou hoje.
                const pausadas = (g.complemento_opcoes ?? [])
                  .filter((o: any) => !o.disponivel && !soSemOpcao(o.nome))
                  .map((o: any) => o.nome)
                const emFalta = pausadas.length ? `\n(em falta hoje — NÃO ofereça nem anote; se pedirem, diga que acabou no momento: ${pausadas.join(", ")})` : ""
                // Barra separadora + nome da categoria em negrito, uma opção por linha.
                return `━━━━━━━━━━━━━\n*${g.nome}* (${quant})\n${ops}${emFalta}`
              }).join("\n\n")
            if (!linhas) continue
            // Com o id: "Açaí CDBOM (Caixa 5 litros)" e "Sorvete CDBOM (Caixa 5
            // litros)" são quase o mesmo nome, e o modelo mostrou os sabores de
            // sorvete pra quem pediu açaí (teste 13/09).
            blocos.push(`▸ ${nomeDoProduto(pid)} [id:${pid}]:\n${linhas}`)
          }
          complementosTexto = blocos.join("\n\n")
          familiasTamanho = familiasPorTamanho(produtos, saboresPorProduto)
        }
      }
    } catch (e) { console.error("[Complementos] erro ao carregar:", e) }

    const carrinho    = carrinhoRes.data?.items ?? []
    const clienteIdNoCarrinho = carrinhoRes.data?.cliente_id ?? null
    const carrinhoEndereco: any = {
      rua:    carrinhoRes.data?.endereco_rua    ?? null,
      numero: carrinhoRes.data?.endereco_numero ?? null,
      bairro: carrinhoRes.data?.endereco_bairro ?? null,
      cidade: carrinhoRes.data?.endereco_cidade ?? null,
      estado: carrinhoRes.data?.endereco_estado ?? null,
      // O ponto que o cliente mandou (mig 0239). É ele que vai pro pedido e que
      // o app do entregador abre — o texto acima é pro papel.
      lat:    carrinhoRes.data?.endereco_lat    ?? null,
      lng:    carrinhoRes.data?.endereco_lng    ?? null,
    }

    let cliente = clienteRes.data ?? null
    if (!cliente && clienteIdNoCarrinho) {
      const { data } = await supabase.from("clientes")
        .select("id, nome, email, cep, numero, endereco, bairro, cidade, estado, telefone, created_at, origem, endereco_lat, endereco_lng, endereco_pin_manual")
        .eq("id", clienteIdNoCarrinho)
        .maybeSingle()
      if (data) cliente = data
    }

    // Verifica profiles global quando não há clientes nessa loja (policy bot_read_profiles USING true)
    let profileGlobal: { nome: string; email: string | null; telefone: string | null; cep: string | null; endereco: string | null; numero: string | null; complemento: string | null; bairro: string | null; cidade: string | null; estado: string | null } | null = null
    if (!cliente) {
      const phonesToTry = [...new Set([phoneLocal, phoneLocalWith9, phoneLocalNo9, phone, `55${phoneLocal}`, `55${phoneLocalWith9}`, `55${phoneLocalNo9}`, `+55${phoneLocal}`, `+55${phoneLocalWith9}`])]
      for (const tel of phonesToTry) {
        const { data: pg } = await supabase.from("profiles").select("nome, email, telefone, cep, endereco, numero, complemento, bairro, cidade, estado").eq("telefone", tel).limit(1).maybeSingle()
        if (pg?.nome) { profileGlobal = { nome: pg.nome, email: pg.email ?? null, telefone: pg.telefone ?? null, cep: pg.cep ?? null, endereco: pg.endereco ?? null, numero: pg.numero ?? null, complemento: pg.complemento ?? null, bairro: pg.bairro ?? null, cidade: pg.cidade ?? null, estado: pg.estado ?? null }; break }
      }
      console.log(`[ProfileGlobal] ${profileGlobal ? `encontrado: ${profileGlobal.nome}` : `não encontrado para ${phoneLocal}`}`)
    }

    // Salva cliente_id no carrinho quando phone lookup encontrou cliente mas carrinho não tem o id
    // Isso garante o fallback clienteIdNoCarrinho em requests futuros mesmo se phone lookup falhar
    if (cliente && !clienteIdNoCarrinho) {
      supabase.from("whatsapp_carrinho")
        .update({ cliente_id: cliente.id, updated_at: new Date().toISOString() })
        .eq("empresa_id", empresaId)
        .eq("phone", phone)
        .then(() => {})
    }

    if (cliente?.cep && !carrinhoEndereco.rua && !(cliente.endereco && cliente.estado)) {
      const resolved = await resolveCepData(supabase, String(cliente.cep))
      if (resolved?.rua) {
        carrinhoEndereco.rua    = resolved.rua
        carrinhoEndereco.bairro = resolved.bairro || null
        carrinhoEndereco.cidade = resolved.cidade || null
        if (!carrinhoEndereco.numero && cliente.numero) carrinhoEndereco.numero = String(cliente.numero)
        supabase.from("whatsapp_carrinho").upsert({
          empresa_id: empresaId, phone,
          endereco_rua: carrinhoEndereco.rua, endereco_numero: carrinhoEndereco.numero,
          endereco_bairro: carrinhoEndereco.bairro, endereco_cidade: carrinhoEndereco.cidade,
          endereco_estado: carrinhoEndereco.estado ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "empresa_id,phone" })
      }
    }

    const clienteNome   = cliente?.nome ?? profileGlobal?.nome ?? null
    const totalCarrinho = carrinho.reduce((s: number, i: any) => s + Number(i.qtd) * Number(i.preco), 0)
    const enderecoCliente = (() => {
      const rua    = carrinhoEndereco.rua    ?? cliente?.endereco ?? null
      const numero = carrinhoEndereco.numero ?? cliente?.numero   ?? null
      const bairro = carrinhoEndereco.bairro ?? cliente?.bairro   ?? null
      const cidade = carrinhoEndereco.cidade ?? cliente?.cidade   ?? null
      const estado = carrinhoEndereco.estado ?? cliente?.estado   ?? null
      if (!rua) return null
      return `${rua}${numero ? `, ${numero}` : ""}${bairro ? ` — ${bairro}` : ""}${cidade ? `, ${cidade}` : ""}${estado ? `/${estado}` : ""}`
    })()

    // BAIRRO primeiro: taxa fixa ou bloqueio do bairro do cliente (prioridade sobre o km).
    const bairroCliente = carrinhoEndereco.bairro ?? cliente?.bairro ?? null
    const cfgBairro = acharBairroCfg(empresa.taxas_entrega_bairro, bairroCliente)
    const bairroBloqueado = aceitaDelivery && !!cfgBairro && cfgBairro.entrega === false
    const bairroTaxaFixa = !!cfgBairro && cfgBairro.entrega !== false
    // Taxa de entrega: bairro (taxa fixa) > km (faixas por distância) > taxa fixa da loja.
    let taxaEntregaCalc = taxaEntrega
    if (aceitaDelivery && bairroTaxaFixa) {
      taxaEntregaCalc = Number(cfgBairro.taxa) || 0
    } else if (aceitaDelivery && !bairroBloqueado) {
      const endParaCalc = [
        carrinhoEndereco.rua ?? cliente?.endereco,
        carrinhoEndereco.numero ?? cliente?.numero,
        carrinhoEndereco.bairro ?? cliente?.bairro,
        carrinhoEndereco.cidade ?? cliente?.cidade,
      ].filter(Boolean).join(", ")
      // Com o ponto do cliente na mão, a distância é a REAL — não precisa
      // perguntar o endereço pro buscador de mapa (que é justamente quem erra).
      const pontoCliente = carrinhoEndereco.lat != null && carrinhoEndereco.lng != null
        ? { lat: Number(carrinhoEndereco.lat), lng: Number(carrinhoEndereco.lng) }
        : null
      if (endParaCalc || pontoCliente) {
        const t = await calcularTaxaEntregaKm(empresa, endParaCalc, pontoCliente)
        if (t != null) taxaEntregaCalc = t
      }
    }

    // Faixa de taxa (menor→maior) das tabelas por km e por bairro. Loja que cobra
    // por distância deixa a taxa fixa em R$ 0 — sem o endereço do cliente, o
    // taxaEntregaCalc cai nesse zero e o robô prometia FRETE GRÁTIS pra quem só
    // perguntou "quanto é a entrega?". Com a faixa em mãos ele responde a
    // realidade ("de R$ 5 a R$ 15, depende de onde você está") e pede o endereço.
    const taxasCadastradas: number[] = [
      ...(Array.isArray(empresa.taxas_entrega_km) ? empresa.taxas_entrega_km : [])
        .map((f: any) => Number(f?.taxa)),
      ...(Array.isArray(empresa.taxas_entrega_bairro) ? empresa.taxas_entrega_bairro : [])
        .filter((b: any) => b?.entrega !== false).map((b: any) => Number(b?.taxa)),
    ].filter((v) => Number.isFinite(v) && v > 0)
    const taxaMin = taxasCadastradas.length ? Math.min(...taxasCadastradas) : null
    const taxaMax = taxasCadastradas.length ? Math.max(...taxasCadastradas) : null

    // ── O CLIENTE COLOU UM LINK DO GOOGLE MAPS ──────────────────────────────
    // Vem antes da IA pelo mesmo motivo do pino: link não é conversa, é dado.
    // O modelo leria a URL como texto e responderia qualquer coisa — e o
    // endereço que estava dentro dela se perderia.
    {
      const achou = text.match(RE_LINK_MAPA)
      if (achou) {
        const { resposta: respMapa } = await handleLinkDoMapa(supabase, empresaId, phone, achou[0])
        await supabase.from("whatsapp_conversas").insert({
          empresa_id: empresaId, phone, role: "assistant", content: respMapa,
        })
        await espelharNoChat(supabase, empresaId, phone, respMapa, "loja", true)
        if (isTest) {
          return new Response(JSON.stringify({ ok: true, resposta: respMapa, _debug: { link: achou[0] } }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } })
        }
        await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({ number: phone, text: respMapa }),
        }).catch(e => console.error("[Mapa] sendText erro:", e))
        return new Response("ok", { headers: corsHeaders })
      }
    }

    // ── "SEM NÚMERO" ────────────────────────────────────────────────────────
    // Quiosque, sítio, casa sem número oficial. A IA respondia "anotei s/n" e
    // não gravava nada: a sacola ficava sem número e o endereço nunca fechava
    // (CDBom, 14/09/2026). Com a rua já na sacola, o código grava S/N e segue.
    if (!coordsMsg && carrinhoEndereco.rua && !carrinhoEndereco.numero &&
        /^\s*(sem[\s-]*n[uú]mero|s\s*\/\s*n[º°o]?|sn|n[aã]o\s+(tem|possui|tenho)\s+n[uú]mero)\s*[.!]?\s*$/i.test(text)) {
      const { resposta: respSn } = await handleSalvarNumero(supabase, empresaId, phone, phoneLocal, "S/N", aceitaDelivery, pgtoOpcoes)
      await supabase.from("whatsapp_conversas").insert({
        empresa_id: empresaId, phone, role: "assistant", content: respSn,
      })
      await espelharNoChat(supabase, empresaId, phone, respSn, "loja", true)
      if (isTest) {
        return new Response(JSON.stringify({ ok: true, resposta: respSn }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      }
      await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: phone, text: respSn }),
      }).catch(e => console.error("[SemNumero] sendText erro:", e))
      return new Response("ok", { headers: corsHeaders })
    }

    // ── O CLIENTE MANDOU A LOCALIZAÇÃO ──────────────────────────────────────
    // Curto-circuito antes da IA: quem responde é o código. Mandar um pino pro
    // modelo seria pagar crédito pra ele decidir o que fazer com um dado que
    // não tem interpretação nenhuma — e arriscar ouvir "não entendi" de quem
    // fez exatamente o que o robô pediu.
    if (coordsMsg) {
      const { resposta: respLoc } = await handleLocalizacao(supabase, empresaId, phone, coordsMsg)
      await supabase.from("whatsapp_conversas").insert({
        empresa_id: empresaId, phone, role: "assistant", content: respLoc,
      })
      await espelharNoChat(supabase, empresaId, phone, respLoc, "loja", true)
      if (isTest) {
        return new Response(JSON.stringify({ ok: true, resposta: respLoc, _debug: { coordsMsg } }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      }
      await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: phone, text: respLoc }),
      }).catch(e => console.error("[Local] sendText erro:", e))
      return new Response("ok", { headers: corsHeaders })
    }

    // ── "QUAIS OS SABORES DO SORVETE?" SEM DIZER O TAMANHO ──────────────────
    // Curto-circuito: os sabores dependem do tamanho, então a primeira resposta
    // é a lista de tamanhos com preço. A IA, com tudo junto no prompt, listava
    // os sabores do maior tamanho como se valessem pra todos.
    {
      const familia = saborSemTamanho(text, familiasTamanho)
      if (familia) {
        const brl = (v: number) => `R$ ${v.toFixed(2).replace(".", ",")}`
        const respTam = `Temos *${familia.nome}* em mais de um tamanho, e os sabores mudam de um pro outro 😊\n\n`
          + familia.tamanhos.map(t => `• ${t.rotulo} — ${brl(t.preco)}`).join("\n")
          + `\n\nQual tamanho você quer? Aí te mando os sabores dele.`
        await supabase.from("whatsapp_conversas").insert({
          empresa_id: empresaId, phone, role: "assistant", content: respTam,
        })
        await espelharNoChat(supabase, empresaId, phone, respTam, "loja", true)
        console.log("[Tamanho] perguntou sabores sem tamanho:", familia.nome)
        if (isTest) {
          return new Response(JSON.stringify({ ok: true, resposta: respTam }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } })
        }
        await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({ number: phone, text: respTam }),
        }).catch(e => console.error("[Tamanho] sendText erro:", e))
        return new Response("ok", { headers: corsHeaders })
      }
    }

    // ── System prompt ────────────────────────────────────────────────────────
    const systemPrompt = `Você é o assistente virtual de vendas da ${empresaNome}. Responda sempre em português.
Seja inteligente e conversacional — entenda o que o cliente quer e responda naturalmente.
${iaInstrucoes ? `\nINSTRUÇÕES DA EMPRESA:\n${iaInstrucoes}\n` : ""}
DADOS DA LOJA:
- Nome: ${empresaNome}
${empresaDescricao ? `- Descrição: ${empresaDescricao}` : ""}
${empresaEndereco   ? `- Endereço: ${empresaEndereco}` : ""}
${agoraTexto        ? `- Agora são ${agoraTexto} (horário de Brasília)` : ""}
${horarioLojaTexto  ? `- ${horarioLojaTexto.replace(/\*/g, "")}` : (empresaHorario ? `- Horário: ${empresaHorario}` : "")}
🟢 A LOJA ESTÁ ABERTA NESTE MOMENTO — o sistema já conferiu a grade de horários antes de te chamar. NUNCA diga que a loja está fechada, nem repita um aviso de "estamos fechados" que apareça no histórico da conversa: aquilo era de antes. Se o cliente perguntar o horário, informe o da linha acima e nenhum outro.
${empresa.chave_pix ? `- PIX: ${empresa.chave_pix} (${empresa.pix_nome ?? ""})` : ""}
CATÁLOGO: ${catalogoUrl}
🚚 TAXA, DISTÂNCIA E CIDADE VIZINHA NUNCA SÃO MOTIVO PRA CHAMAR ATENDENTE. Quem calcula a taxa é o SISTEMA, pela distância do endereço. Cliente mandou a cidade/bairro que faltava → emita salvar_rua com rua + bairro + cidade na hora (mesmo que seja outra cidade, ex.: Natal) e o valor sai certo. Só diga que não entrega quando aparecer "ENTREGA BLOQUEADA" aqui.
📍 "Vocês entregam em [cidade/bairro]?": NUNCA responda "sim" nem "não" de cabeça — a entrega vai até uma distância da loja e só o endereço diz. Responda que a loja fica em ${empresaEndereco || "—"}, e peça a localização ou rua, número e bairro pra conferir na hora.
${aceitaDelivery ? (bairroBloqueado ? `⛔ ENTREGA BLOQUEADA NESTE BAIRRO: a loja NÃO entrega no bairro do cliente (${bairroCliente}). Avise educadamente que ainda não entregam nesse bairro e ofereça RETIRADA no local. NUNCA feche um pedido de ENTREGA para este cliente — só retirada.`
  : enderecoCliente ? `ENTREGA: taxa R$ ${taxaEntregaCalc.toFixed(2)} (já calculada pela distância do endereço do cliente)`
  : taxaMin != null ? `ENTREGA: a taxa depende do endereço — vai de R$ ${taxaMin.toFixed(2)} a R$ ${taxaMax!.toFixed(2)}. ⛔ NUNCA diga um valor exato, e MUITO MENOS "R$ 0,00" ou frete grátis, enquanto não souber o endereço: diga a faixa e peça a rua, o número e o bairro — o sistema calcula a taxa certa na hora de fechar.`
  : `ENTREGA: taxa R$ ${taxaEntregaCalc.toFixed(2)} (taxa base — pode mudar conforme a distância do endereço)`) : "ENTREGA: somente retirada no local"}
FORMAS DE PAGAMENTO (SÓ estas — nunca ofereça outra): ${opcoesDePagamento(pagamentos).replace(/\*/g, "")}
${pagamentos.pixOnline ? `• PIX (online): o sistema gera o QR Code e o copia-e-cola ao fechar o pedido — o pedido só vai para a loja depois que o pagamento for confirmado. Você NÃO envia chave PIX nesse caso.\n` : ""}${pagamentos.pixEntrega ? `• PIX${pagamentos.pixOnline ? " na entrega" : ""}: o cliente faz o PIX pelo app do banco dele, para a chave PIX da loja${pagamentos.chavePix ? ` (${pagamentos.chavePix})` : ""}, e manda o COMPROVANTE aqui na conversa pra concluir o pedido — igual à Loja Online. NÃO usa maquininha e não tem QR. NUNCA diga pra pagar só quando o pedido chegar. O sistema manda a chave junto da confirmação do pedido; você nunca confirma que o pagamento caiu (quem confere é a loja).${pagamentos.pixOnline ? "" : " Quando o cliente disser \"PIX\", é este."}\n` : ""}${!pagamentos.pixOnline && !pagamentos.pixEntrega ? `• PIX NÃO é aceito nesta loja pelo WhatsApp — se pedirem, ofereça as formas acima.\n` : ""}${aceitaCartao(pagamentos) ? `• Cartão: se for ENTREGA, o entregador leva a maquininha. Se for RETIRADA, paga no balcão da loja (aí não tem entregador — nunca fale dele).${pagamentos.credito && pagamentos.debito ? " Pergunte se é *crédito* ou *débito*." : ""}\n` : ""}

${totalProdutos > MENU_INTEIRO_ATE ? `⚠️ CATÁLOGO GRANDE: esta loja tem ${totalProdutos} produtos e eles NÃO cabem aqui. A lista abaixo é só o que casou com o que o cliente falou até agora — NÃO é o catálogo inteiro.
• Venda só o que está na lista (com [id:]), como sempre.
• Se ele pedir algo que não está aí, NUNCA diga que a loja não tem. Diga que vai conferir e peça a MARCA e o TAMANHO ("Skol lata 350?"): o sistema procura com essas palavras e o item aparece aqui na próxima mensagem.
• Categorias da loja: ${(catsHorario ?? []).map((c: any) => c.nome).join(", ") || "—"}
` : ""}PRODUTOS DISPONÍVEIS${totalProdutos > MENU_INTEIRO_ATE ? " (o que casou com o que ele pediu)" : ""}:
${cardapioPorCategoria(produtos) || (totalProdutos > MENU_INTEIRO_ATE ? "Nada casou com o que ele falou — peça a marca e o tamanho, ou ofereça o link do catálogo." : "Nenhum produto cadastrado")}
${complementosTexto ? `\nPRODUTOS QUE SÃO MONTADOS COM COMPLEMENTOS (o cliente escolhe dentro de cada categoria):\n${complementosTexto}\n${Object.keys(exigencias).length ? `⚠️ ESCOLHA OBRIGATÓRIA: nesses produtos, a categoria que tem PREÇO nas opções (borda, sabores da pizza) é obrigatória — pergunte junto com o resto e NÃO anote sem ela. "Sem borda" também é uma escolha: se o cliente disser que não quer, anote "Sem borda".\n` : ""}${familiasTamanho.length ? `📏 SABORES QUE MUDAM CONFORME O TAMANHO — nunca liste sabores desses produtos sem saber o tamanho. Se o cliente não disse o tamanho (nem antes na conversa), PERGUNTE primeiro qual tamanho, mostrando tamanhos e preços; depois mostre só os sabores DAQUELE tamanho:\n${familiasTamanho.map(f => `▸ ${f.nome}: ` + f.tamanhos.map(t => `${t.rotulo} (${t.sabores.length} sabores)`).join("; ")).join("\n")}\n` : ""}⚠️ Confira pelo [id:] qual produto o cliente pediu antes de mostrar opções. Produto cujo id NÃO aparece neste bloco não tem sabor/complemento pra escolher: adicione direto com atualizar_carrinho, sem perguntar sabor (ex.: açaí em caixa ou balde não é o mesmo produto que o sorvete de mesmo tamanho).\n🍦 SABOR NÃO ESCOLHIDO NÃO SE PERGUNTA: nos produtos em que só se escolhe o SABOR (picolé, sorvete, moreninha, pote), se o cliente disse produto + quantidade sem sabor, emita atualizar_carrinho NA HORA com a linha SEM "complementos" (nem "Misturado" — Misturado é só quando ele FALA misturado/sortido/menos X) — a loja manda sortido. Não liste sabores, não pergunte "qual sabor?" nem "prefere misturado?". Só use sabor quando ELE disser um.\n` : ""}
CARRINHO ATUAL: ${carrinho.length === 0 ? "Vazio" : `\n${carrinho.map((i: any) => {
  const comps = Array.isArray(i.complementos) && i.complementos.length ? ` (${i.complementos.map((c: any) => c.nome).join(", ")})` : ""
  return `• ${i.nome}${comps} x${i.qtd} = R$ ${(i.qtd * Number(i.preco)).toFixed(2)}`
}).join("\n")}\nSUBTOTAL: R$ ${totalCarrinho.toFixed(2)}`}
⚠️ No resumo (PASSO 6) use EXATAMENTE estes preços e este SUBTOTAL do CARRINHO ATUAL. Itens montados (quentinha) já têm os adicionais embutidos no preço — NUNCA use o preço base da lista de produtos nem recalcule.
💰 PREÇO POR QUANTIDADE (ATACADO) E PROMOÇÃO:
• Na lista, "a partir de 10 un: R$ 2.50 cada" quer dizer que levando 10 ou mais daquele produto CADA UM sai por esse valor. Abaixo disso vale o preço normal. A quantidade conta a SOMA do produto no carrinho, mesmo com sabores diferentes (5 de morango + 5 de chocolate = 10).
• Quando o cliente perguntar o preço de um produto assim, diga os DOIS valores ("R$ 4,00 a unidade, ou R$ 2,50 cada a partir de 10").
• Se ele pedir um pouco menos que a faixa (ex.: 7 ou 8 de 10), avise UMA vez quanto sairia completando a faixa. Não insista.
• "de R$ X por R$ Y (PROMOÇÃO)" = o valor que vale é o Y.
• No atualizar_carrinho mande o preço que quiser: o SISTEMA aplica atacado e promoção sozinho, e o CARRINHO ATUAL já mostra o valor certo.
• A descrição depois do produto (tamanho, avisos, "só na quarta") vale como informação da loja — use pra responder o cliente.

CLIENTE: ${cliente?.nome ? `✅ JÁ CADASTRADO — ${cliente.nome}${enderecoCliente ? ` (Endereço: ${enderecoCliente})` : ""}
⛔ PROIBIDO pedir nome ou e-mail deste cliente — ele JÁ é cadastrado. Cumprimente-o pelo nome. Quando ele fechar a sacola, vá DIRETO para entrega/retirada (PASSO 4), NUNCA para o cadastro (PASSO 3).` : "Não cadastrado nesta loja"}
TELEFONE: ${phoneLocal}
${profileGlobal ? `NOME_NO_SISTEMA: ${profileGlobal.nome}` : ""}

══════════════════════════════════════
IDENTIDADE E ACESSO
══════════════════════════════════════
Você tem acesso completo a todos os dados da loja, banco de clientes e gestor de pedidos.

SUAS RESPONSABILIDADES:
• Responder qualquer dúvida sobre a loja, produtos, preços e funcionamento
• Realizar pedidos completos pelo WhatsApp seguindo o fluxo abaixo
• Manter o cliente informado em cada etapa do pedido

══════════════════════════════════════
FLUXO DE VENDA — SIGA EXATAMENTE ESTA ORDEM
══════════════════════════════════════

▶ PASSO 1 — SAUDAÇÃO
Já verificamos pelo telefone se o cliente tem conta nesta loja (ver CLIENTE acima).
• SE CLIENTE tem nome real (já é cliente desta loja) → cumprimente pelo nome, de forma calorosa. Diga que ele pode pedir pelo link OU por aqui mesmo, e ajude a montar a sacola. Inclua ao final: "\n👉 ${catalogoUrl}"
• SE CLIENTE = "Não cadastrado nesta loja" → saudação calorosa oferecendo o LINK como a forma mais fácil e rápida de pedir, mas deixando claro que dá pra pedir por aqui também. NÃO peça nome, e-mail nem endereço agora. Exemplo:
  "Oi! 😊 Seja bem-vindo(a) à ${empresaNome}! A forma mais rápida de pedir é pelo nosso cardápio online, é só clicar:\n👉 ${catalogoUrl}\n\nMas se preferir, é só me dizer o que deseja que eu monto seu pedido por aqui mesmo! O que vai querer hoje?"

▶ PASSO 2 — MONTAR A SACOLA
Ajude o cliente a escolher os produtos. A CADA produto escolhido, emita atualizar_carrinho (ver AÇÕES).
Cliente pediu VÁRIOS produtos de uma vez ("um balde, dez picolés e um açaí"): anote de uma vez todos que você já sabe QUAL produto é (sabor não escolhido não segura: vai sem sabor). Só pergunte do que ficou em dúvida de QUAL produto é ("Agora os 10 picolés: qual tipo?"). Só pergunte "deseja mais algum item?" quando todos os que ele pediu estiverem no carrinho.
Preço: use SEMPRE o da linha do produto, dentro da categoria certa (【SORVETES】 não é 【AÇAÍ】, mesmo com o mesmo tamanho).
Produto com complementos (Quentinha): mostre TODAS as categorias DE UMA VEZ, numa ÚNICA mensagem. Use EXATAMENTE o formato do bloco "PRODUTOS QUE SÃO MONTADOS COM COMPLEMENTOS": cada categoria com a barra separadora (━━━━━━━━━━━━━), o *nome da categoria* em negrito com o máximo do lado (ex.: "escolha 1", "escolha até 2"), e CADA opção numa linha própria começando com "• ". NUNCA junte as opções com vírgula na mesma linha — elas têm que ficar uma embaixo da outra. A linha "(em falta hoje ...)" é só pra você: NUNCA mostre ela na lista. NUNCA pergunte categoria por categoria (uma mensagem por categoria) — isso cansa o cliente e gasta crédito à toa. Peça pro cliente responder tudo numa mensagem só; quando ele responder, monte o item com atualizar_carrinho. Se faltar escolher alguma categoria, aí sim pergunte só as que faltam.
Continue somando itens até o cliente dizer que é só isso / que quer fechar.
⚠️ Enquanto monta a sacola, NUNCA peça nome, e-mail, CEP, endereço, entrega ou pagamento. Isso é SÓ depois que a sacola fechar.

RETOMANDO DEPOIS DE UMA PESSOA: se nas últimas mensagens quem respondeu foi alguém da loja (uma pessoa assumiu porque você chamou), ela já resolveu aquele ponto. NÃO repita o que ela disse, NÃO peça de novo o que ela já perguntou e NÃO se apresente de novo. Leia a resposta dela como sua, agradeça em uma linha se fizer sentido e siga o pedido do ponto onde parou (sacola → cadastro → endereço → entrega/retirada → pagamento → resumo).

▶ PASSO 3 — CADASTRO (só DEPOIS da sacola fechada, e só se CLIENTE = "Não cadastrado nesta loja")
Se o cliente JÁ tem nome em CLIENTE → PULE este passo inteiro, vá direto ao PASSO 4.
⚠️ GATILHO: assim que o cliente indicar que fechou a sacola ("é só isso", "pode fechar", "só isso mesmo", "fechar"), sua PRÓXIMA mensagem JÁ deve pedir o *nome* (item 1 abaixo). NÃO pergunte "quer mais algum item?" de novo, NÃO mostre resumo ainda. Se o cliente mandar o nome por conta própria, ACEITE e siga a ordem — nunca responda "quer mais alguma coisa?".
Colete UM POR VEZ, nesta ordem exata:
  1. "⚡ Estamos com um sistema novo por aqui! Seu cadastro é rapidinho e *uma vez só* — no próximo pedido já não precisa. 😊\n\nPra começar, qual o seu *nome*?"
  2. Recebeu o nome → emita cadastrar_cliente IMEDIATAMENTE (sem texto antes). O sistema pede o endereço em seguida — pedindo a LOCALIZAÇÃO primeiro, e deixando rua/número/bairro ou CEP como alternativa.
  3. Recebeu a LOCALIZAÇÃO (o pininho do WhatsApp) → NÃO faça nada: o sistema já leu o ponto, guardou a rua/bairro/cidade e perguntou o número sozinho, antes de você. Essa mensagem nem chega em você.
     Recebeu o CEP → emita buscar_cep (sem texto antes). O sistema confirma o endereço e pede o número.
     Recebeu o endereço ESCRITO (sem CEP) → emita salvar_rua com rua + bairro + cidade (sem texto antes). O sistema pede o número.
     ⚠️ O cliente pode mandar o endereço em PEDAÇOS (a rua numa mensagem, o bairro na outra). Trate como um endereço só: quando vier o bairro solto depois da rua, emita salvar_rua de novo com a rua que você já tem MAIS o bairro novo.
  4. Recebeu o número → emita salvar_numero. O sistema pergunta entrega/retirada automaticamente.
     Lugar SEM número (quiosque, sítio, barraca, "não tem número", só um ponto de referência) → emita salvar_numero com "S/N" na hora. Ponto de referência NÃO é número e NUNCA diga "anotei" sem emitir a ação — o pino do mapa é que guia o entregador.
O telefone já temos (${phoneLocal}) — NUNCA peça.
⚠️ CRÍTICO: só o *nome* é obrigatório. ⛔ NUNCA peça e-mail — o sistema não precisa dele.

▶ PASSO 4 — ENTREGA OU RETIRADA
${aceitaDelivery
  ? `Pergunte: "Prefere *entrega* 🚚 ou vai *retirar* na loja? 🏪"\n\nSE ENTREGA:\n• SE já temos o endereço (ver CLIENTE, ou acabou de coletar no cadastro) → confirme: "Vou entregar em *[endereço]*. Está correto? 😊"\n  - Confirma → PASSO 5\n  - Quer trocar → peça o endereço novo: se vier CEP emita buscar_cep, se vier escrito emita salvar_rua (rua+bairro+cidade); depois o número (emita salvar_numero)\n• SE ainda não temos endereço → peça numa frase curta: "📍 Me manda sua *localização* ou o endereço (rua, número e bairro)." NÃO ensine como mandar a localização (clipe, menu etc.). Se ele mandar o CEP por conta própria, aceite numa boa. Escrito → salvar_rua; CEP → buscar_cep. Depois o número (emita salvar_numero), aí siga ao PASSO 5\n\nSE RETIRADA:\n• Informe: "Pode retirar em: *${empresaEndereco || empresaNome}*. ✅"\n• Vá ao PASSO 5`
  : `Somente retirada no local.\nInforme: "Pode retirar em: *${empresaEndereco || empresaNome}*. ✅"\nVá ao PASSO 5`}

▶ PASSO 5 — FORMA DE PAGAMENTO
"Como vai pagar: ${pgtoOpcoes}? 💳"
Aguarde a resposta.
Se escolher DINHEIRO: pergunte "Vai precisar de troco? Se sim, pra quanto? 💵" e aguarde. Ele pode responder "não", "pra 50", "nota de 100"... Só depois vá ao resumo. Se ele já disse o valor antes (ex.: "dinheiro, troco pra 100"), não pergunte de novo.${pagamentos.pixOnline ? "\nSe escolher PIX: NÃO mande chave nem texto de pagamento — apenas siga para o resumo (PASSO 6) e, ao confirmar, emita fechar_pedido com forma_pagamento \"pix\". O sistema gera o QR e o copia-e-cola sozinho." : ""}${pagamentos.pixEntrega ? `\nSe escolher PIX NA ENTREGA${pagamentos.pixOnline ? "" : " (ou só \"PIX\")"}: siga para o resumo e, ao confirmar, emita fechar_pedido com forma_pagamento "pix_entrega". Não precisa de troco.` : ""}${pagamentos.credito && pagamentos.debito ? `\nSe escolher CARTÃO: pergunte "Crédito ou débito?" e use forma_pagamento "credito" ou "debito".` : ""}

▶ PASSO 6 — RESUMO E CONFIRMAÇÃO
Após ter entrega/retirada E pagamento confirmados, envie o resumo completo:

"📋 *Resumo do pedido:*

[liste cada item: • Nome x qtd — R$ valor]
${aceitaDelivery ? `🚚 Taxa de entrega: R$ ${taxaEntregaCalc.toFixed(2)} (só se for entrega — use EXATAMENTE este valor)` : ""}
💰 *Total: R$ [total]*

📍 [Entrega em: endereço / Retirada em: endereço da loja]
💳 Pagamento: [${opcoesDePagamento(pagamentos).replace(/\*/g, "").replace(/, | ou /g, "/")}]
[só se for dinheiro com troco: 💵 Troco para: R$ valor]

Confirma? 😊"

→ Cliente confirma → emita fechar_pedido IMEDIATAMENTE

▶ PASSO 7 — ACOMPANHAMENTO (automático — você NÃO faz nada aqui)
O sistema avisa sozinho quando a loja confirma o pedido, quando ele sai para entrega / fica pronto para retirada (mandando o *código* ao cliente) e quando é entregue (pedindo a avaliação de 1 a 5 ⭐).

══════════════════════════════════════
REGRAS IMPORTANTES
══════════════════════════════════════
1. NUNCA invente produtos ou preços — use APENAS a lista acima
2. NUNCA peça o telefone — já temos: ${phoneLocal}
3. NUNCA peça CEP nem endereço se já temos o endereço do cliente (ver CLIENTE acima)
4. O resumo (PASSO 6) é OBRIGATÓRIO antes de fechar. NUNCA emita fechar_pedido sem antes mostrar o resumo e receber confirmação. E NUNCA mostre resumo/total ANTES de ter entrega/retirada E pagamento definidos — ao fechar a sacola, se o cliente não é cadastrado, a próxima coisa é pedir o NOME (PASSO 3), sem resumo ainda.
5. Para cliente novo colete SÓ o nome — e SÓ depois que a sacola estiver fechada (nunca durante a montagem). ⛔ NUNCA peça e-mail.
6. CEP (8 dígitos): emita buscar_cep IMEDIATAMENTE, sem texto antes. Endereço escrito (ex.: "Rua das Flores, 42, Centro, Assu"): emita salvar_rua IMEDIATAMENTE com rua+bairro+cidade, sem texto antes — e se ele mandar o número junto, emita salvar_numero na sequência
7. NUNCA assuma forma de pagamento ou tipo de entrega sem perguntar nesta conversa
8. ⚠️ CRÍTICO — CARRINHO: toda vez que o cliente escolher um produto VOCÊ DEVE emitir ACAO: atualizar_carrinho com TODOS os itens. NUNCA diga "anotei" ou "adicionei" sem emitir esta ACAO. Sem ela o carrinho fica vazio e o pedido NÃO é criado.
9. NUNCA diga o que vai fazer antes de fazer. Proibido: "Deixa eu criar...", "Deixa eu fechar...", "Vou verificar...". Emita a ACAO diretamente — a confirmação vem automática. Se não há ACAO, termine sempre com uma pergunta.

══════════════════════════════════════
AÇÕES DISPONÍVEIS
══════════════════════════════════════

Atualizar carrinho (ao adicionar/remover produto — OBRIGATÓRIO ao confirmar produto escolhido):
ACAO: {"tipo": "atualizar_carrinho", "items": [{"produto_id": "ID_REAL", "nome": "Nome", "qtd": 1, "preco": 0.00}]}

▸ PRODUTO COM COMPLEMENTOS (ex.: Quentinha) — fluxo obrigatório (produto que só tem SABOR pra escolher — picolé, sorvete, pote — NÃO segue este fluxo: vale a regra SABOR logo abaixo):
  1. Quando o cliente escolher um produto que está na lista "PRODUTOS QUE SÃO MONTADOS COM COMPLEMENTOS", NÃO adicione direto. Primeiro mostre TODAS as categorias daquele produto no MESMO formato do bloco de referência: barra separadora (━━━━━━━━━━━━━), *nome da categoria* em negrito com o máximo ("escolha 1"/"escolha até 2"), e cada opção numa linha própria com "• " (NUNCA vírgula na mesma linha). Peça que ele diga o que quer em cada categoria.
  2. Respeite o máximo de cada categoria — nunca aceite mais opções do que o "escolha até N" permite. Mas se o cliente escolher menos do que o máximo permitido (ex.: 1 salada quando pode 2), está OK — NÃO fique insistindo para ele adicionar mais. Assim que ele disser as opções, emita atualizar_carrinho na hora.
  3. Assim que o cliente disser as opções (mesmo que junto com "só isso"), sua PRÓXIMA ação é emitir atualizar_carrinho com a quentinha montada. ⛔ NUNCA mostre uma lista de confirmação com ✓ ("Deixa eu confirmar sua Quentinha: • X ✓") antes de emitir — isso deixa o carrinho VAZIO e o pedido sai errado. Emita a ACAO direto; a confirmação vem automática do sistema.
     - "preco" = preço base do produto + a soma dos adicionais pagos (os que têm "+R$") escolhidos.
     - inclua SEMPRE "complementos": lista com o que ele escolheu, cada um {"nome": "opção", "qtd": 1}. Sem os complementos a cozinha não sabe o que fazer.
  ACAO: {"tipo": "atualizar_carrinho", "items": [{"produto_id": "ID_REAL", "nome": "Quentinha (M)", "qtd": 1, "preco": 17.00, "complementos": [{"nome": "Feijão Preto", "qtd": 1}, {"nome": "Arroz refogado", "qtd": 1}, {"nome": "Frango Assado", "qtd": 1}]}]}

▸ SABOR (picolé, sorvete, pote — categoria "escolha 1" de sabor) com VÁRIAS unidades:
  • "escolha 1" vale POR UNIDADE, não pro pedido todo. Cliente que quer 10 picolés de sabores diferentes PODE — nunca diga que só dá um sabor.
  • Monte UMA LINHA POR SABOR, com a quantidade de cada. "10 Picolé Delícia, 5 de morango e 5 de chocolate" vira:
  ACAO: {"tipo": "atualizar_carrinho", "items": [{"produto_id": "ID_REAL", "nome": "Picolé Delícia", "qtd": 5, "preco": 4.00, "complementos": [{"nome": "Morango", "qtd": 1}]}, {"produto_id": "ID_REAL", "nome": "Picolé Delícia", "qtd": 5, "preco": 4.00, "complementos": [{"nome": "Chocolate", "qtd": 1}]}]}
  • A soma das linhas conta pro preço de atacado — o sistema junta sozinho.
  • ⛔ Se ele disser o produto e a quantidade e NÃO disser sabor ("70 picolé de gelo", "20 moreninha"), NÃO pergunte o sabor: anote NA HORA sem sabor — a linha SEM "complementos" (não invente "Misturado"). A loja já sabe que sem sabor escolhido ela manda sortido. Ex.: {"produto_id": "ID_REAL", "nome": "Picolé Sabor da Fruta", "qtd": 70, "preco": 1.50}
  • "Todos menos X" / "menos de X" / "tirando X" / "sem X" = misturado sem aquele sabor: {"nome": "Misturado", "qtd": 1, "exceto": ["X"]}. O sistema divide entre os outros sabores. Se X nem existe no produto, só anote — não diga que X acabou.
  • Se disser os sabores e não a divisão ("10 de morango e chocolate"), pergunte quantos de cada antes de anotar.
  • Pedido com vários produtos, uns com sabor e outros sem: anote TODOS numa ACAO só (os com sabor, uma linha por sabor; os sem sabor, só o produto e a quantidade). O sistema responde com a conferência e o valor total.
  • Sabor que ele pedir e NÃO está na lista do produto está em falta hoje: responda como atendente ("Castanha acabou no momento 😕, mas tem esses:") e ofereça os que tem. NUNCA fale em "lista", "cadastro" ou "sistema" pro cliente. Nunca anote sabor fora da lista.
  • Cada produto tem a SUA lista de sabores (o pote de 1 litro pode não ter o mesmo sabor do balde). Use a lista daquele produto.

${temMeioAMeio ? `▸ PIZZA MEIO A MEIO (o grupo que diz "o preço é o do sabor MAIS CARO"):
  • "Meia X e meia Y", "metade X metade Y", "2 sabores", "X com Y" = o produto que tem esse grupo, com os DOIS sabores em "complementos" (e a borda, se o produto tiver).
  • Preço = o do sabor MAIS CARO (+ a borda, que soma). NUNCA some os dois sabores. Ex.: meia de R$ 34,99 + meia de R$ 45,00 = R$ 45,00. O sistema calcula sozinho; no texto, cite só o do mais caro.
  • Pizza de UM sabor só (inteira) = o produto daquele sabor na categoria dele, não o de 2 sabores.
  • Mesmo sabor em dois blocos (ex.: "3 Queijos (Promoção)" e "3 Queijos (Especiais)") tem preço diferente: pergunte qual antes de anotar.
  • Escreva a opção com o nome COMPLETO, igual à lista (com o que está entre parênteses).
  • Borda que o produto exige ("escolha 1"): pergunte junto com os sabores, numa mensagem só ("Sem borda" é uma opção).
  ACAO: {"tipo": "atualizar_carrinho", "items": [{"produto_id": "ID_REAL", "nome": "Pizza 2 Sabores", "qtd": 1, "preco": 45.00, "complementos": [{"nome": "Calabresa Acebolada (Promoção)", "qtd": 1}, {"nome": "4 Queijos (Especiais)", "qtd": 1}, {"nome": "Sem borda", "qtd": 1}]}]}

` : ""}▸ "MISTURADO" / "SORTIDO" / "VARIADO" / "O RESTO MISTURADO":
  • Quer dizer que a LOJA escolhe os sabores. NÃO pergunte sabor por sabor. Anote a linha com o sabor "Misturado" — o SISTEMA divide a quantidade igualmente entre os sabores disponíveis do produto e a conferência já mostra a divisão:
  ACAO: {"tipo": "atualizar_carrinho", "items": [{"produto_id": "ID_REAL", "nome": "Picolé Sabor da Fruta", "qtd": 40, "preco": 1.50, "complementos": [{"nome": "Misturado", "qtd": 1}]}]}
  • Pode ter sabor escolhido + resto misturado: "50 picolés, 10 de coco e o resto misturado" = uma linha de 10 Coco + uma linha de 40 Misturado (do mesmo produto).
  • "20 picolé cobertura menos de paçoca": ACAO: {"tipo": "atualizar_carrinho", "items": [{"produto_id": "ID_REAL", "nome": "Picolé Premium", "qtd": 20, "preco": 4.00, "complementos": [{"nome": "Misturado", "qtd": 1, "exceto": ["Paçoca"]}]}]}
  • "80 misturado de A e B" (DOIS produtos juntos) é UM total de 80, NUNCA 80 de cada. Pergunte UMA vez como dividir, já sugerindo: "Divido meio a meio — 40 de A e 40 de B — pode ser?". Se o cliente não se importar, anote meio a meio com "Misturado".
  • NUNCA anote item com quantidade 0 ou sem quantidade. Sem a quantidade, pergunte.

Cadastrar cliente novo (após coletar o nome — PASSO 3, só depois da sacola fechada):
ACAO: {"tipo": "cadastrar_cliente", "nome": "[nome]"}
⚠️ Emita IMEDIATAMENTE após receber o nome. SEM texto antes. O sistema pede o endereço (rua, número e bairro) em seguida.

Buscar endereço pelo CEP (quando cliente enviar o CEP):
ACAO: {"tipo": "buscar_cep", "cep": "59640000"}

Salvar endereço escrito pelo cliente (ele mandou o endereço em vez do CEP, ou o CEP não tinha logradouro):
ACAO: {"tipo": "salvar_rua", "rua": "Rua das Flores", "bairro": "Centro", "cidade": "Assu", "estado": "RN"}
⚠️ Mande SEMPRE o *bairro* e a *cidade* quando o cliente disser — é o que define a taxa de entrega. Se ele mandou só a rua, pergunte o bairro e a cidade ANTES de emitir. "estado" só se ele disser.
⚠️ NUNCA invente o bairro nem a cidade, e NUNCA complete com a cidade da loja: o cliente pode morar na cidade vizinha.

Salvar número da casa:
ACAO: {"tipo": "salvar_numero", "numero": "42"}
⚠️ Após salvar, o sistema pergunta entrega/retirada automaticamente.

Fechar pedido — CLIENTE IDENTIFICADO (tem nome em CLIENTE acima, ou cadastrar_cliente foi emitido nesta sessão):
ACAO: {"tipo": "fechar_pedido", "tipo_entrega": "entrega", "forma_pagamento": "dinheiro", "cliente_rua": "[rua confirmada na conversa]", "cliente_numero": "[número confirmado]", "cliente_bairro": "[bairro]", "cliente_cidade": "[cidade]", "cliente_estado": "[estado]", "items": [{"produto_id": "ID_REAL", "nome": "Nome", "qtd": 1, "preco": 0.00}]}
[tipo_entrega: "entrega" ou "retirada" | forma_pagamento: ${[pagamentos.dinheiro && `"dinheiro"`, pagamentos.pixOnline && `"pix"`, pagamentos.pixEntrega && `"pix_entrega"`, pagamentos.credito && `"credito"`, pagamentos.debito && `"debito"`, (pagamentos.cartao || (aceitaCartao(pagamentos) && !(pagamentos.credito && pagamentos.debito))) && `"cartao"`].filter(Boolean).join(", ")} | dinheiro com troco: acrescente "troco_para": 100 (o valor da nota que ele vai dar; sem troco, não mande o campo)]
⚠️ SEMPRE inclua os "items" do carrinho atual E o endereço confirmado na conversa no ACAO fechar_pedido
⚠️ SE for retirada, omita os campos cliente_rua/numero/bairro/cidade/estado

Fechar pedido — CLIENTE SEM CADASTRO (raro: CLIENTE = "Não identificado" e cadastrar_cliente não foi emitido):
ACAO: {"tipo": "fechar_pedido", "tipo_entrega": "retirada", "forma_pagamento": "dinheiro", "cliente_nome": "[nome]", "cliente_telefone": "${phoneLocal}", "items": [{"produto_id": "ID_REAL", "nome": "Nome", "qtd": 1, "preco": 0.00}]}
⚠️ CRÍTICO: sem cliente_nome o pedido NÃO é criado

COMPROVANTE DE PAGAMENTO (foto ou print de PIX/transferência):
⛔ Você NUNCA confirma pagamento. Uma foto não prova que o dinheiro caiu — comprovante pode ser falso, agendado ou de outro valor. PROIBIDO dizer "pagamento confirmado", "PIX confirmado", "recebemos seu pagamento" ou "pedido pago".
Responda: "Recebi seu comprovante! 🙌 A loja confere o pagamento e confirma seu pedido por aqui." Pode citar o valor que aparece na foto, mas sempre como algo que a loja ainda vai conferir.

Chamar uma pessoa da loja (VOCÊ NÃO SABE responder, ou o cliente está insistindo/incomodado):
Mande antes: "Já chamei alguém aqui da loja pra te ajudar. 🙌 Só um instante!" e emita:
ACAO: {"tipo": "chamar_atendente", "motivo": "o que o cliente quer, em poucas palavras"}
⚠️ É a saída CERTA pra garantia, troca, nota fiscal, reclamação, negociação de preço, pedido antigo, ou qualquer coisa que não esteja nos dados acima. Chamar gente é sempre melhor do que inventar uma resposta.
⚠️ NUNCA diga "vou verificar", "vou conferir com o responsável", "te retorno" ou "já aviso a loja" SEM emitir esta ação na mesma mensagem. Sem a ação, ninguém fica sabendo e o cliente espera um retorno que não vem. Ou você responde agora, ou emite chamar_atendente.
⚠️ Depois disso você para de responder esse cliente — quem fala é a pessoa da loja.

Escalar para humano (problema que a IA não resolve):
ACAO: {"tipo": "escalar_humano", "problema": "descrição"}
Após emitir: "Entendi! Já avisei a loja e em breve alguém entra em contato. 😊"

Parar o robô / falar com humano (a pessoa pede CLARAMENTE pra parar — "para", "desativa", "não quero robô", "quero falar com atendente/humano" — ou é claramente alguém da loja mandando recado interno):
Mande UMA despedida curta: "Ok! 👍 Vou avisar a loja pra te atender por aqui." e emita:
ACAO: {"tipo": "pausar_bot", "motivo": "descrição curta do porquê"}
⚠️ Só use quando for CLARO que a pessoa quer parar ou falar com humano. NUNCA por dúvida comum, reclamação leve ou pergunta sobre o pedido.
`

    const primeiraMsg = !mensagens.some((m: any) => m.role === "assistant")
    const jaConfirmacaoModel2 = mensagens.some((m: any) => m.role === "assistant" && m.content?.includes("Vi que você já é cliente"))

    // Fluxo: cliente tem conta no app mas não é desta loja → pede confirmação dos dados
    // Usa jaConfirmacaoModel2 em vez de primeiraMsg: garante que a mensagem aparece mesmo com histórico residual
    if (profileGlobal && !cliente && !jaConfirmacaoModel2) {
      const telExibir = profileGlobal.telefone ?? phoneLocal
      const emailExibir = profileGlobal.email ?? "não informado"
      // Monta endereço completo se disponível
      let enderecoExibir = ""
      if (profileGlobal.endereco) {
        const partes = [profileGlobal.endereco, profileGlobal.numero, profileGlobal.complemento, profileGlobal.bairro, profileGlobal.cidade, profileGlobal.estado].filter(Boolean)
        enderecoExibir = partes.join(", ")
      }
      const linhaEndereco = enderecoExibir ? `\n*Endereço:* ${enderecoExibir}` : `\n*Endereço:* não informado`
      const linhaCep = profileGlobal.cep ? `\n*CEP:* ${profileGlobal.cep}` : ""
      const respostaConfirmacao = `Oi! 👋 Vi que você já é cliente *FWC Inter* mas ainda não é cliente do *${empresaNome}*.\n\nMe confirma se seus dados estão corretos para eu fazer seu cadastro:\n\n*Nome:* ${profileGlobal.nome}\n*E-mail:* ${emailExibir}\n*Telefone:* ${telExibir}${linhaEndereco}${linhaCep}\n\nEstá tudo certo? Posso te cadastrar? 😊\n👉 ${catalogoUrl}`
      await Promise.all([
        supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "assistant", content: respostaConfirmacao }),
        supabase.rpc("descontar_credito_whatsapp", { p_empresa_id: empresaId }),
      ])
      if (isTest) return new Response(JSON.stringify({ ok: true, resposta: respostaConfirmacao, _debug: { profileGlobal, phoneLocal } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
        method: "POST", headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: phone, text: respostaConfirmacao }),
      }).catch(e => console.error("[sendText] erro:", e))
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    // Cliente confirmou os dados → cadastra e atende normal
    if (profileGlobal && !cliente && jaConfirmacaoModel2) {
      const textoLower = text.toLowerCase().trim()
      const confirmou = /^(sim|s\b|yes|ok|correto|pode|confirmo|tá|ta\b|certo|isso|exato|perfeito|claro|com certeza|pode cadastrar|cadastra|confirma|tudo certo)/.test(textoLower)
      if (confirmou) {
        await handleCadastrarCliente(supabase, empresaId, phone, phoneLocal, profileGlobal.nome, profileGlobal.email, SUPABASE_URL, SUPABASE_KEY, indicadorProfileId, {
          endereco: profileGlobal.endereco, numero: profileGlobal.numero, complemento: profileGlobal.complemento,
          bairro: profileGlobal.bairro, cidade: profileGlobal.cidade, estado: profileGlobal.estado, cep: profileGlobal.cep,
        })
        // Salva endereço no carrinho para que handleFecharPedido encontre na hora do pedido
        if (profileGlobal.endereco) {
          await supabase.from("whatsapp_carrinho").update({
            endereco_rua: profileGlobal.endereco, endereco_numero: profileGlobal.numero ?? null,
            endereco_bairro: profileGlobal.bairro ?? null, endereco_cidade: profileGlobal.cidade ?? null,
            endereco_estado: profileGlobal.estado ?? null,
          }).eq("empresa_id", empresaId).eq("phone", phone)
        }
        const respostaOk = `✅ Tudo certo, ${profileGlobal.nome}! Cadastro feito!\n\nO que vai pedir hoje? 🛒`
        await Promise.all([
          supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "assistant", content: respostaOk }),
          supabase.rpc("descontar_credito_whatsapp", { p_empresa_id: empresaId }),
        ])
        if (isTest) return new Response(JSON.stringify({ ok: true, resposta: respostaOk, _debug: { profileGlobal, phoneLocal, confirmou } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
        await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
          method: "POST", headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
          body: JSON.stringify({ number: phone, text: respostaOk }),
        }).catch(e => console.error("[sendText] erro:", e))
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      }
      // Não confirmou ou quer corrigir dados → cai no Claude com contexto do profile
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        // Pedido grande de revenda (CDBom, 14/09/2026: 16 linhas de picolé,
        // cremosinho, gelo e sorvete) não cabia em 900: o modelo escrevia a lista
        // pro cliente e a ACAO com os produto_id ficava de fora. Só custa mais
        // quando a resposta é grande de verdade.
        max_tokens: 2000,
        system:     systemPrompt,
        messages:   mensagens.map((m: any, idx: number) => {
          if (imageBase64 && idx === mensagens.length - 1 && m.role === "user") {
            return {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: imageMimetype, data: imageBase64 } },
                { type: "text", text: m.content || "O cliente enviou essa imagem. Interprete o que ele quer pedir." },
              ],
            }
          }
          return { role: m.role, content: m.content }
        }),
      }),
    })

    if (!claudeRes.ok) {
      const claudeErr = await claudeRes.text()
      console.error("Claude error:", claudeErr)
      if (isTest) return new Response(JSON.stringify({ ok: false, erro: "claude", status: claudeRes.status, detalhe: claudeErr.slice(0, 500) }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })
      return new Response("ok", { headers: corsHeaders })
    }

    const claudeData = await claudeRes.json()
    // Quanto custou ESTA resposta. A loja paga R$ 0,07 por crédito (1 crédito =
    // 1 resposta); sem ver o custo real não dá pra saber se a conta fecha —
    // catálogo grande no prompt já custou mais que o crédito no passado.
    {
      const u = claudeData.usage ?? {}
      const entrada = Number(u.input_tokens ?? 0)
      const saida = Number(u.output_tokens ?? 0)
      const usd = (entrada / 1e6) * 1 + (saida / 1e6) * 5   // Haiku 4.5: $1/$5 por M
      console.log(`[custo] in=${entrada} out=${saida} ≈ US$ ${usd.toFixed(5)} (~R$ ${(usd * 5.4).toFixed(3)}) | crédito da loja: R$ 0,07`)
    }
    let resposta: string = claudeData.content?.[0]?.text ?? ""

    const acaoStart = resposta.indexOf("ACAO:")
    let acaoMatch: RegExpMatchArray | null = null
    if (acaoStart !== -1) {
      const fromAcao   = resposta.slice(acaoStart + 5).trimStart()
      const braceStart = fromAcao.indexOf("{")
      if (braceStart !== -1) {
        let depth = 0, end = -1
        for (let i = braceStart; i < fromAcao.length; i++) {
          if (fromAcao[i] === "{") depth++
          else if (fromAcao[i] === "}") { depth--; if (depth === 0) { end = i; break } }
        }
        if (end !== -1) acaoMatch = ["", fromAcao.slice(braceStart, end + 1)] as any
      }
    }
    // Sem "ACAO:" na frente? Pode ser o formato de ferramenta que o modelo às
    // vezes usa por conta própria. Aqui a ação é resgatada e o bloco sai do
    // texto — senão ela não roda E o cliente lê o JSON.
    let acaoSoltaFim = -1
    if (!acaoMatch) {
      const solta = acharAcaoSolta(resposta)
      if (solta) {
        console.log("[Acao] formato fora do padrão resgatado:", solta.json.slice(0, 80))
        acaoMatch = ["", solta.json] as any
        resposta = (resposta.slice(0, solta.ini) + " " + resposta.slice(solta.fim)).trim()
        acaoSoltaFim = solta.fim
      }
    }

    // DISSE QUE ANOTOU E NÃO ANOTOU. O Haiku às vezes responde "Anotei! Vou
    // adicionar o gelo" sem a ação — o cliente acredita, e a sacola fica sem o
    // item (teste da CDBom, 13/09). Uma segunda chamada curta pedindo SÓ a ação
    // custa uma fração do crédito e salva o pedido.
    // Também quando ele lista a sacola com preço sem gravar: "Então fica: 2x Pote
    // 1 litro Flocos — R$ 24,00". Foi assim no cliente que trocou o balde três
    // vezes (teste 13/09): quatro "confirmações" e a sacola vazia no banco.
    // O resumo fica de fora — nele a sacola já está salva.
    // "Deixa eu anotar: 20 Moreninhas" também (CDBom, 15/09/2026): sem esta
    // forma a 2ª chamada não rodava, e no "só isso" o cliente ouviu que a
    // sacola estava vazia.
    const falaDeSacola = /\b(anotei|anotado|(deixa eu|deixe-me|vou|j[aá] vou) anotar|anotando|adicionei|adicionad[oa]s?|vou adicionar|coloquei|inclu[ií]|troquei|tirei|removi|entao fica|então fica|fica assim|vai ficar|deixa eu confirmar|s[oó] pra confirmar|sua sacola|seu carrinho)\b/i.test(resposta)
    const listaItemComPreco = /(\b\d+\s*x\s+\S|\bx\s*\d+\b)[^\n]*R\$/i.test(resposta)
    // RESPONDEU A ESCOLHA E SEGUIU EM FRENTE COM A SACOLA VAZIA.
    //
    // O robô cobrou a borda, o cliente respondeu "sem borda mesmo", e o modelo
    // achou que o assunto tinha acabado: disse "Perfeito!" e foi perguntar se é
    // entrega ou retirada — sem nunca ter gravado a pizza (testado 25/09 na
    // pizzaria de demonstração). Não casa "anotei" nem lista preço, então as
    // duas peneiras de cima deixam passar. O sinal certo aqui é outro: a fala
    // ANTERIOR do robô cobrava uma escolha e a sacola continua vazia.
    const escolhaPerdida = roboPediuEscolha && !(carrinho ?? []).length
    if (!acaoMatch && !/resumo do pedido/i.test(resposta) && (falaDeSacola || listaItemComPreco || escolhaPerdida)) {
      try {
        const retry = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            // Cada item da sacola leva produto_id + nome + sabor (~100 tokens).
            // Com 600 a ACAO de um pedido de 16 linhas saía cortada, o JSON não
            // fechava e a sacola ficava vazia (CDBom, 14/09/2026).
            max_tokens: 3000,
            system: systemPrompt,
            messages: [
              ...mensagens.map((m: any) => ({ role: m.role, content: m.content })),
              { role: "assistant", content: resposta },
              { role: "user", content: escolhaPerdida && !falaDeSacola && !listaItemComPreco
                ? "[SISTEMA — não é o cliente] O cliente acabou de responder a escolha que faltava (borda, sabor, tamanho), mas você não emitiu a ação e a sacola está VAZIA — o item que vocês montaram na conversa não existe no banco. Responda SOMENTE com a linha ACAO: atualizar_carrinho com esse item inteiro (produto + todas as escolhas combinadas na conversa), com o produto_id real da lista. Nenhum texto além da ACAO."
                : "[SISTEMA — não é o cliente] Você disse ao cliente que anotou, mas não emitiu a ação, e o carrinho NÃO foi salvo. Responda SOMENTE com a linha ACAO: atualizar_carrinho com TODOS os itens do carrinho (os que já estavam no CARRINHO ATUAL + os novos), com o produto_id real da lista. Nenhum texto além da ACAO." },
            ],
          }),
        })
        if (retry.ok) {
          const txt: string = (await retry.json()).content?.[0]?.text ?? ""
          const ini = txt.indexOf("ACAO:")
          const bloco = ini !== -1 ? jsonBalanceado(txt, ini) : null
          const achado = bloco?.texto ?? acharAcaoSolta(txt)?.json ?? null
          const recuperada = achado ? JSON.parse(achado) : null
          // "Anotei o troco de 200" também casa a peneira. Se a sacola que
          // voltou é a mesma que já está salva, não havia item esquecido — e
          // aplicar a ação reabria a conferência da sacola no meio do pagamento.
          if (recuperada?.tipo === "atualizar_carrinho" && mesmoCarrinho(recuperada.items, carrinho)) {
            console.log("[Acao] 2ª chamada devolveu a sacola igual — nada a gravar")
          } else if (recuperada?.tipo === "atualizar_carrinho") {
            console.log("[Acao] recuperada na 2ª chamada:", achado.slice(0, 120))
            acaoMatch = ["", achado] as any
            acaoSoltaFim = 0   // não cortar a resposta por um "ACAO:" que ela não tem
          } else {
            console.error("[Acao] 2ª chamada não trouxe atualizar_carrinho:", txt.slice(0, 200))
          }
        }
      } catch (e: any) { console.error("[Acao] 2ª chamada falhou:", e?.message) }
    }

    let acaoPromise: Promise<any> = Promise.resolve()
    let mensagemExtra             = ""
    const extraMsgs: string[]     = []
    // QR do PIX quando a loja é da Meta: quem envia é o whatsapp-cloud, então
    // ele volta na resposta em vez de sair por aqui.
    let pixQrParaCloud = ""
    let pixNumeroParaCloud = ""

    if (acaoMatch) {
      // Só corta pelo "ACAO:" quando foi ele que casou — no formato resgatado o
      // texto já foi limpo acima, e cortar de novo comeria a resposta inteira.
      if (acaoStart !== -1 && acaoSoltaFim === -1) resposta = resposta.slice(0, acaoStart).trim()
      try {
        const acao = JSON.parse(acaoMatch[1])

        // Sabor que o produto não tem ou que está pausado: nada é gravado nem
        // fechado, e o cliente escolhe de novo (ver conferirSabores).
        if ((acao.tipo === "atualizar_carrinho" || acao.tipo === "fechar_pedido") && Array.isArray(acao.items)) {
          // Item sem quantidade não entra: saía "Picolé Cremoso" com a sacola
          // em R$ 0,00 (CDBom, 14/09). Se não sobrar nada, não mexe na sacola
          // salva — fica a fala do modelo, que é a pergunta da quantidade.
          const antes = acao.items.length
          acao.items = acao.items.filter((i: any) => Number(i?.qtd) > 0)
          if (antes && !acao.items.length) {
            console.log(`[Carrinho] ${acao.tipo} sem quantidade em nenhum item — ignorado`)
            acao.tipo = "sem_quantidade"
          } else {
            // "Misturado" que o cliente não pediu: "70 picolé de gelo" saía
            // dividido em 10 sabores. Sem sabor escolhido a linha vai só com o
            // nome e a loja manda sortido (pedido da loja, 15/09/2026). Vale o
            // que ele escreveu agora e nas últimas mensagens dele.
            const falasDoCliente = normSabor([text, ...mensagens.filter((m: any) => m.role === "user").slice(-4).map((m: any) => m.content)].join(" "))
            const pediuMisturar = /\b(misturad[oa]s?|mistura|misturar|sortid[oa]s?|variad[oa]s?|mix|loja escolhe|voces escolhem|tanto faz)\b/.test(falasDoCliente)
            const pediuTirar = /\b(menos|tirando|exceto|fora|sem)\b/.test(falasDoCliente)
            for (const it of acao.items) {
              const comps = Array.isArray(it?.complementos) ? it.complementos : []
              if (comps.length !== 1) continue
              const mist = lerMisturado(comps[0])
              if (!mist.misturado) continue
              const vale = mist.exceto.length ? (pediuTirar || pediuMisturar) : pediuMisturar
              if (!vale) {
                console.log(`[Sabor] Misturado sem o cliente pedir — ${it.nome} vai sem sabor`)
                it.complementos = []
              }
            }
            acao.items = distribuirMisturado(acao.items, saboresPorProduto)
          }
        }
        if ((acao.tipo === "atualizar_carrinho" || acao.tipo === "fechar_pedido") && Array.isArray(acao.items)) {
          acertarProdutoPelasEscolhas(acao.items, produtos, saboresPorProduto)
          // A fala do cliente entra nas duas conferências: é ela que diz se ele
          // escolheu a calabresa (e se dispensou a borda) ou se o modelo
          // decidiu isso por ele.
          const falaRecente = mensagens.filter((m: any) => m.role === "user")
            .slice(-3).map((m: any) => String(m.content ?? "")).join(" | ")
          // Antes do sabor vem o PRODUTO: não adianta acertar a borda de uma
          // pizza que talvez nem seja a que o cliente quis.
          const avisoProduto = conferirProdutoAmbiguo(acao.items, produtos, carrinho,
            { fala: falaRecente, jaPerguntou: roboPediuEscolha })
          const avisoSabor = avisoProduto ?? conferirSabores(acao.items, saboresPorProduto, produtos,
            { fala: falaRecente, jaPerguntou: roboPediuEscolha })
          if (avisoProduto) console.log("[Produto] ambíguo, perguntando:", avisoProduto.slice(0, 120))
          if (avisoSabor) {
            console.log(`[Sabor] ${acao.tipo} barrado:`, avisoSabor.slice(0, 200))
            acao.tipo = "sabor_invalido"
            resposta = avisoSabor
          } else {
            // Escolha obrigatória que ficou faltando (a borda da pizza) ou que
            // passou do limite (3 sabores numa de 2).
            const avisoEscolha = conferirEscolhas(acao.items, exigencias, produtos,
              { fala: falaRecente, jaPerguntou: roboPediuEscolha })
            if (avisoEscolha) {
              console.log(`[Escolha] ${acao.tipo} barrado:`, avisoEscolha.slice(0, 160))
              acao.tipo = "escolha_incompleta"
              resposta = avisoEscolha
            }
          }
        }

        if (acao.tipo === "atualizar_carrinho" && Array.isArray(acao.items)) {
          // Recalcula o preço no servidor (verdade do banco) — o modelo erra a conta.
          // preço = preço da quantidade (promoção/atacado) + adicionais das opções.
          reprecificarItens(acao.items, produtos, precoOpcaoMap, regrasOpcao)
          const carrinhoResult = await handleAtualizar_carrinho(supabase, empresaId, phone, acao.items)
          if (!carrinhoResult.ok) console.error("[Carrinho] falhou:", carrinhoResult)
          // Sacola igual à que já estava e o modelo disse algo: a fala dele
          // segue (ele reenviou a sacola por garantia no meio do pagamento).
          // Trocar pela conferência fazia o cliente voltar um passo.
          const semMudanca = mesmoCarrinho(acao.items, carrinho) && resposta.trim().length > 0
          if (semMudanca) console.log("[Carrinho] reenviado sem mudança — mantém a resposta do modelo")
          // Sempre substitui resposta do Haiku — evita "Vou adicionar..." (REGRA 10 não é respeitada pelo modelo)
          if (acao.items.length > 0 && !semMudanca) {
            const nomes = acao.items.map((i: any) => `${i.nome} x${i.qtd}`).join(", ")
            // Detalhe com os complementos escolhidos — pro cliente CONFERIR o que foi anotado
            // (se a IA anotou errado, ele corrige antes de fechar).
            const temComp = acao.items.some((i: any) => Array.isArray(i.complementos) && i.complementos.length > 0)
            const detalhe = detalheDaSacola(acao.items)
            // Enxuto de propósito (pedido da loja, 14/09/2026): produto,
            // quantidade, valor e sabores numa linha. Do aviso de atacado só
            // fica a DICA ("com mais 2 sai a R$ X") — o "levando 30 sai a R$ 2"
            // repetia o que o valor do produto já mostra.
            const dicaAtacado = avisoDeAtacado(acao.items, produtos)
              .split("\n").filter(l => l.startsWith("💡")).join("\n")
            void nomes
            const cabecalho = `✅ Anotei! Confere:\n\n${detalhe}`
              + (dicaAtacado ? `\n\n${dicaAtacado}` : "")
              // O valor da sacola a cada item: o cliente não chega no resumo
              // levando susto, e ajusta a quantidade enquanto escolhe.
              + `\n\n🛒 Total: *R$ ${totalDaSacola(acao.items).toFixed(2).replace(".", ",")}*`
            // Transição determinística: se o cliente já sinalizou fechar a sacola,
            // não pergunta "quer mais?" — segue direto para cadastro (se novo) ou entrega (se já cliente).
            const querFechar = /\b(pode fechar|só isso|so isso|é só isso|e so isso|só isso mesmo|so isso mesmo|fechar( o)? pedido|finaliza|encerra|é isso|e isso|pode mandar|pode confirmar)\b/i.test(text)
            if (querFechar && !cliente) {
              resposta = `${cabecalho}\n\n⚡ Estamos com um sistema novo por aqui! Seu cadastro é rapidinho e *uma vez só* — no próximo pedido já não precisa. 😊\n\nPra começar, qual o seu *nome*?`
            } else if (querFechar && cliente) {
              resposta = aceitaDelivery
                ? `${cabecalho}\n\nPrefere *entrega* 🚚 ou vai *retirar* na loja? 🏪`
                : `${cabecalho}\n\nPode retirar em: *${empresaEndereco || empresaNome}*. Como vai pagar: ${pgtoOpcoes}? 💳`
            } else {
              // Pedido de vários itens de uma vez ("balde, dez picolés e um
              // açaí"): anotado o balde, o modelo já pergunta dos picolés. O
              // "deseja mais algum item?" fixo apagava essa pergunta, e o
              // cliente fechava sem os outros dois (conversa real, 13/09).
              // Tudo o que o modelo disse depois da parte da sacola (a lista dos
              // tipos de picolé + a pergunta), e não só o último parágrafo — senão
              // sobrava um "O que você prefere?" solto, sem a lista.
              const resto = resposta.split(/\n\s*\n/).map(p => p.trim())
                // Sabor que ele não escolheu não se pergunta: vai sem sabor e a
                // loja manda sortido (15/09/2026).
                .filter(p => p && !/(anotei|anotado|adicionad|confere|carrinho|sacola|✅|🍽️|deixa eu confirmar|s[oó] pra confirmar|vamos confirmar|fechar|mais algum|mais alguma|misturad|qual sabor|quais sabores|sabor espec[ií]fico|tem dispon[ií]vel)/i.test(p))
                .join("\n\n")
              const perguntaDoModelo = resto.includes("?") && resto.length <= 1200 ? resto : ""
              resposta = perguntaDoModelo
                ? `${cabecalho}\n\n${perguntaDoModelo}`
                : `${cabecalho}\n\n${temComp ? "Tá certo? " : ""}Mais alguma coisa ou posso fechar? 😊`
            }
          }

        } else if (acao.tipo === "verificar_cliente" && acao.busca) {
          const resultado = await handleVerificarCliente(
            supabase, empresaId, String(acao.busca), phone, phoneLocal, catalogoUrl, carrinho
          )
          if (resultado.resposta) {
            resposta = resultado.resposta
          } else {
            resposta += "\n\nNão encontrei seu cadastro ainda! Vou te cadastrar agora. 😊\n\nQual é o seu *nome*?"
          }
          if (resultado.cliente) cliente = resultado.cliente

        } else if (acao.tipo === "cadastrar_cliente" && acao.nome) {
          // O modelo também pode pegar a confirmação ("Sim sim") como nome.
          if (!pareceNomeDePessoa(String(acao.nome))) {
            const achado = nomeDaRajada(mensagens, text)
            console.log(`[Nome] cadastrar_cliente veio com "${acao.nome}" — usando "${achado ?? "-"}"`)
            if (achado) acao.nome = achado
          }
          await handleCadastrarCliente(
            supabase, empresaId, phone, phoneLocal,
            String(acao.nome), acao.email ? String(acao.email) : null,
            SUPABASE_URL, SUPABASE_KEY, indicadorProfileId
          )
          // Após cadastro, coleta endereço — com a saída da retirada à vista
          resposta = textoDepoisDoCadastro(aceitaDelivery, empresaEndereco || empresaNome, pgtoOpcoes)

        } else if (acao.tipo === "pedir_cep") {
          // sem ação — Claude já pediu o CEP na resposta

        } else if (acao.tipo === "buscar_cep" && acao.cep) {
          const resultado = await handleBuscarCep(supabase, empresaId, phone, String(acao.cep))
          resposta = resultado.resposta

        } else if (acao.tipo === "salvar_rua" && acao.rua) {
          const resultado = await handleSalvarRua(
            supabase, empresaId, phone, String(acao.rua),
            acao.bairro ? String(acao.bairro) : null,
            acao.cidade ? String(acao.cidade) : null,
            acao.estado ? String(acao.estado) : null,
          )
          resposta = resultado.resposta

        } else if (acao.tipo === "salvar_numero" && acao.numero) {
          const resultado = await handleSalvarNumero(supabase, empresaId, phone, phoneLocal, String(acao.numero), aceitaDelivery, pgtoOpcoes)
          resposta = resultado.resposta

        } else if (acao.tipo === "fechar_pedido") {
          // Corrige entrega/retirada pela conversa (o modelo às vezes erra o tipo —
          // ex.: cliente disse "retirar" e o fechar veio como entrega).
          const tipoConv = tipoEntregaDaConversa(mensagens)
          if (tipoConv && acao.tipo_entrega !== tipoConv) {
            console.log(`[SafeNet] tipo_entrega corrigido pela conversa: ${acao.tipo_entrega} -> ${tipoConv}`)
            acao.tipo_entrega = tipoConv
          }
          // Fallback: se cliente não identificado e ACAO sem nome/email, extrai da conversa
          if (!cliente && !acao.cliente_nome) {
            for (let i = 0; i < mensagens.length; i++) {
              const m = mensagens[i]
              if (m.role !== "assistant") continue
              const lower = (m.content ?? "").toLowerCase()
              const next  = mensagens[i + 1]
              if (!next || next.role !== "user") continue
              const val = (next.content ?? "").trim()
              if (!acao.cliente_nome && /nome/.test(lower) && !/e-?mail/.test(lower) && val.length >= 2 && !val.includes("@"))
                acao.cliente_nome = val
              if (!acao.cliente_email && /e-?mail/.test(lower) && val.includes("@"))
                acao.cliente_email = val
            }
            if (!acao.cliente_telefone) acao.cliente_telefone = phoneLocal
            console.log(`[Fallback] nome="${acao.cliente_nome}" email="${acao.cliente_email}"`)
          }
          // Backstop: carrinho vazio (modelo não emitiu atualizar_carrinho) → extrai itens do resumo
          if (carrinho.length === 0 && !(Array.isArray(acao.items) && acao.items.length > 0)) {
            const extraidos = extrairItensDoResumo(mensagens)
            if (extraidos.length > 0) {
              acao.items = extraidos
              console.log(`[Fechar] ${extraidos.length} itens extraídos do resumo (carrinho vazio)`)
            }
          }
          const resultado = await handleFecharPedido(
            supabase, empresaId, phone, phoneLocal, acao, carrinho,
            cliente, empresa, SUPABASE_URL, SUPABASE_KEY, instanceName, carrinhoEndereco,
            indicadorProfileId, taxaEntregaCalc, mensagens, produtos, precoOpcaoMap, regrasOpcao
          )
          if (resultado.bloqueioMensagem) {
            resposta = resultado.bloqueioMensagem
          } else {
            // Ignorar texto vago do Haiku antes da ACAO — usar só a confirmação do sistema
            resposta    = resultado.mensagemExtra
            acaoPromise = resultado.acaoPromise
            if (resultado.pixCode) extraMsgs.push(resultado.pixCode)
            if (resultado.pixQrBase64) { pixQrParaCloud = resultado.pixQrBase64; pixNumeroParaCloud = resultado.pixNumero ?? "" }
          }

        } else if (acao.tipo === "chamar_atendente") {
          // O sino do gestor (mig 0228), o mesmo do robô do link. Diferente do
          // pausar_bot: aqui a pausa acaba quando alguém atende, e a loja pode
          // devolver a conversa pro robô continuar de onde parou.
          await abrirChamado(supabase, empresaId, phone, String(acao.motivo ?? text).slice(0, 300))
          resposta = "Já chamei alguém aqui da loja pra falar com você. 🙌 Só um instante!"
          console.log("[chamado] a IA pediu ajuda:", acao.motivo ?? "")

        } else if (acao.tipo === "escalar_humano" && adminPhone) {
          const resumoConversa = mensagens.slice(-10).map((m: any) =>
            `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content}`
          ).join("\n")
          const problema = acao.problema ?? "Problema relatado pelo cliente"
          const alertaMsg = `🚨 *ALERTA — ${empresaNome}*\n\n` +
            `*Problema:* ${problema}\n` +
            `*Cliente:* ${clienteNome ?? "Não identificado"}\n` +
            `*Telefone:* ${phoneLocal}\n\n` +
            `*Últimas mensagens:*\n${resumoConversa}`
          fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
            body: JSON.stringify({ number: `55${adminPhone}`, text: alertaMsg }),
          }).catch(e => console.error("[Escalar] erro ao notificar admin:", e))
          console.log(`[Escalar] alerta enviado para ${adminPhone}`)

        } else if (acao.tipo === "pausar_bot") {
          // A pessoa pediu pra PARAR / falar com humano (ou é recado interno da equipe).
          // Pausa o robô neste número — MESMA tabela/checagem da pausa manual (linha ~1037),
          // então nada muda no fluxo: a partir da próxima mensagem o robô fica quieto.
          // Permanente: a loja religa reativando o número no painel. Avisa a loja.
          await supabase.from("whatsapp_bot_pausado")
            .upsert({ empresa_id: empresaId, phone, pausado_em: new Date().toISOString() },
                    { onConflict: "empresa_id,phone" })
          if (adminPhone) {
            const resumoConversa = mensagens.slice(-6).map((m: any) =>
              `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content}`
            ).join("\n")
            const alertaMsg = `⏸️ *ROBÔ PAUSADO — ${empresaNome}*\n\n` +
              `O robô parou de responder este número porque a pessoa pediu (parar / falar com humano). Assuma a conversa por aqui. 👇\n\n` +
              `*Telefone:* ${phoneLocal}\n` +
              `*Cliente:* ${clienteNome ?? "Não identificado"}\n` +
              `*Motivo:* ${acao.motivo ?? "pediu parar/humano"}\n\n` +
              `Pra religar o robô, reative o número no painel do WhatsApp.\n\n` +
              `*Últimas mensagens:*\n${resumoConversa}`
            fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
              body: JSON.stringify({ number: `55${adminPhone}`, text: alertaMsg }),
            }).catch(e => console.error("[PausarBot] erro ao notificar:", e))
          }
          console.log(`[PausarBot] número ${phone} pausado (pediu parar/humano)`)
        }
      } catch (e) {
        console.error("[ACAO] erro ao processar:", e)
      }
    }

    if (mensagemExtra) resposta += mensagemExtra

    // Safety net: Claude confirmou fechamento sem emitir fechar_pedido
    // Dispara mesmo com carrinho vazio no DB (Claude usa acao.items como fallback)
    if (!acaoMatch) {
      const pareceFechar = /fechando\s+(?:o\s+)?(?:seu\s+)?pedido|pedido\s+(?:#\w+\s+)?(?:foi\s+)?(?:fechado|enviado|criado|registrado)|✅\s+Pedido\s+(?:fechado|criado|enviado)/i.test(resposta)
      // Rede de segurança extra: o cliente confirmou o RESUMO com um "sim" curto e a IA não fechou.
      // Só dispara se a ÚLTIMA mensagem do bot foi o resumo do pedido ("Confirma?") — não pega o "Está correto?" do endereço.
      const ultimaBot = (mensagens.filter((m: any) => m.role === "assistant").pop()?.content ?? "")
      const ultimaBotEhResumo = /resumo do pedido|confirma\?/i.test(ultimaBot)
      const usuarioConfirmou = /^(sim|s|isso|isso mesmo|confirma|confirmar|confirmado|pode|pode fechar|pode confirmar|fechar|fecha|ok|claro|certo|t[áa]\b|perfeito|com certeza|manda|bora|positivo|fechado)\b/i.test(text.trim())
      const confirmouResumo = ultimaBotEhResumo && usuarioConfirmou
      if (pareceFechar || confirmouResumo) {
        console.log("[SafeNet] fechar_pedido não emitido — auto-executando")
        // Analisa APENAS mensagens do usuário para detectar pagamento/entrega
        // (evita falso "pix" que vem da pergunta do bot "cartão, dinheiro ou PIX?")
        const userMsgs = mensagens
          .filter((m: any) => m.role === "user")
          .map((m: any) => (m.content ?? "").toLowerCase())
        const lastPayMsg = [...userMsgs].reverse().find(c =>
          c.includes("pix") || c.includes("cart") || c.includes("dinh") || c.includes("crédito") || c.includes("credito") || c.includes("débito") || c.includes("debito")
        )
        const forma_pagamento = lastPayMsg ? normalizarFormaPgto(lastPayMsg, pagamentos) : (pagamentos.dinheiro ? "dinheiro" : normalizarFormaPgto("", pagamentos))
        const tipo_entrega = tipoEntregaDaConversa(mensagens) ?? "entrega"
        const safeAcao: any = { tipo_entrega, forma_pagamento }

        // Se o carrinho do DB está vazio, tenta extrair itens da conversa
        if (carrinho.length > 0) {
          safeAcao.items = carrinho
        } else {
          const extraidos = extrairItensDoResumo(mensagens)
          if (extraidos.length > 0) {
            safeAcao.items = extraidos
            console.log(`[SafeNet] ${extraidos.length} itens extraídos da conversa`)
          }
        }

        if (!cliente) {
          for (let i = 0; i < mensagens.length; i++) {
            const m = mensagens[i]
            if (m.role !== "assistant") continue
            const lower = (m.content ?? "").toLowerCase()
            const next  = mensagens[i + 1]
            if (!next || next.role !== "user") continue
            const val = (next.content ?? "").trim()
            if (!safeAcao.cliente_nome && /nome/.test(lower) && !/e-?mail/.test(lower) && val.length >= 2 && !val.includes("@"))
              safeAcao.cliente_nome = val
            if (!safeAcao.cliente_email && /e-?mail/.test(lower) && val.includes("@"))
              safeAcao.cliente_email = val
          }
          if (!safeAcao.cliente_telefone) safeAcao.cliente_telefone = phoneLocal
        }
        const resultado = await handleFecharPedido(
          supabase, empresaId, phone, phoneLocal, safeAcao,
          carrinho, cliente, empresa,
          SUPABASE_URL, SUPABASE_KEY, instanceName, carrinhoEndereco,
          indicadorProfileId, taxaEntregaCalc, mensagens, produtos, precoOpcaoMap, regrasOpcao
        )
        if (resultado.bloqueioMensagem) {
          // O bloqueio VAI pro cliente. Antes ele era descartado aqui e ficava
          // valendo o texto do modelo — que já tinha dito "pedido confirmado".
          // O cliente sentava pra esperar comida que a loja nem sabia que
          // existia: nenhum pedido tinha sido criado.
          resposta = resultado.bloqueioMensagem
          console.log("[SafeNet] fechamento bloqueado:", resultado.bloqueioMensagem.slice(0, 60))
        } else {
          acaoPromise = resultado.acaoPromise
          if (resultado.mensagemExtra) resposta = resultado.mensagemExtra
          if (resultado.pixCode) extraMsgs.push(resultado.pixCode)
          if (resultado.pixQrBase64) { pixQrParaCloud = resultado.pixQrBase64; pixNumeroParaCloud = resultado.pixNumero ?? "" }
        }
      }
    }

    // Safety net: usuário mandou CEP mas Claude não emitiu buscar_cep
    const isCepMsg = /^\d{5}-?\d{3}$/.test(text.replace(/\s/g, ""))
    const buscarCepJaExecutado = acaoMatch !== null && (() => {
      try { return JSON.parse(acaoMatch![1])?.tipo === "buscar_cep" } catch { return false }
    })()
    if (isCepMsg && !buscarCepJaExecutado) {
      console.log("[CEP] safety net para:", text)
      const resultado = await handleBuscarCep(supabase, empresaId, phone, text)
      resposta = resultado.resposta
    }

    // Safety net: o robô PROMETEU perguntar pra alguém e não emitiu a ação.
    // Aconteceu em "Galioto tem?" — ele respondeu "vou verificar com o
    // responsável e retorno em breve" e não avisou ninguém: o cliente ficou
    // esperando um retorno que não existia. Promessa de retorno agora abre o
    // chamado e toca o sino no gestor, sempre.
    const prometeuVerificar = new RegExp([
      // "vou verificar", "deixa eu conferir", "te retorno"
      // "confirmar" ficou de FORA: "deixa eu confirmar tudo antes de fechar" é
      // o robô lendo o resumo do pedido, e essa frase chegou a abrir chamado
      // no meio do fechamento — calando o robô justamente no "sim" do cliente.
      "(vou|deixa eu|deixe-me|posso) (verificar|conferir|checar|perguntar)",
      "com o respons[\u00e1a]vel", "com a loja", "retorno (em breve|pra voc[\u00eae])",
      "te retorno", "assim que (eu )?souber", "vou falar com",
      // "já chamei alguém" — a frase que o próprio roteiro manda dizer ANTES
      // da ação. Ele escrevia isso e não emitia a ação: o cliente ouvia que
      // tinha sido chamado alguém que nunca soube de nada.
      "j[\u00e1a] (chamei|estou chamando|vou chamar)", "chamei (algu[\u00e9e]m|uma pessoa|um atendente)",
      "vou (chamar|pedir pra) algu[\u00e9e]m", "algu[\u00e9e]m (da loja )?(j[\u00e1a] )?(vai|est[\u00e1a]) (te )?(falar|falando|responder|respondendo|ajudar|ajudando|atender|atendendo)",
      "j[\u00e1a] (aviso|avisei) a loja",
    ].join("|"), "i").test(resposta)
    const chamouAtendente = acaoMatch !== null && (() => {
      try { return JSON.parse(acaoMatch![1])?.tipo === "chamar_atendente" } catch { return false }
    })()
    // Resumo e fechamento nunca são pedido de socorro — é o robô trabalhando.
    const ehResumoOuFechamento = /resumo do pedido|confirma\?|pedido #|total:/i.test(resposta)
    if (prometeuVerificar && !chamouAtendente && !ehResumoOuFechamento) {
      await abrirChamado(supabase, empresaId, phone, text)
      console.log("[chamado] SafeNet: o robô prometeu retorno, chamado aberto")
    }

    // Safety net: o robô se perdeu e inventou. Foi na CDBom em 14/09/2026, com
    // um fornecedor que fala com a loja pelo mesmo número: ele mandou "1 essência
    // de chiclete" e o robô respondeu "Anotei tudo aqui" (itens que nem existem
    // no cardápio, sacola vazia, nenhuma ação) e "quando a gente abrir hoje
    // (08:00)" às 09:44, com a loja aberta — copiou de um aviso antigo da
    // conversa. Nos dois casos a resposta dele vai pro lixo e quem fala é gente.
    //   1. Disse que anotou, sem ação nenhuma e com a sacola vazia (a segunda
    //      chamada lá em cima já tentou gravar e não conseguiu).
    //   2. Disse que a loja está fechada. Aqui ela está aberta: o aviso de
    //      fechada sai antes, sem chamar a IA.
    if (!chamouAtendente && !ehResumoOuFechamento) {
      const semAcao = acaoMatch === null
      const disseQueAnotou = /\b(anotei|anotad[oa]s?|adicionei|coloquei)\b/i.test(resposta)
      const disseFechada = !forcarIa && /((estamos|a gente (t[áa]|est[áa])|a loja (t[áa]|est[áa])) fechad|quando (a gente|a loja|n[óo]s) abrir|(a gente|a loja) abre (hoje|amanh[ãa]|[àa]s))/i.test(resposta)
      if ((semAcao && disseQueAnotou && carrinho.length === 0) || disseFechada) {
        await abrirChamado(supabase, empresaId, phone, text)
        resposta = "Já chamei alguém aqui da loja pra falar com você. 🙌 Só um instante!"
        console.log(`[chamado] SafeNet: robô ${disseFechada ? "disse que a loja está fechada" : "anotou sem sacola"} — chamado aberto`)
      }
    }

    // Safety net: o robô CONFIRMOU PAGAMENTO olhando a foto do comprovante.
    // Foi na CDBom em 14/09/2026: "Comprovante recebido! PIX de R$ 19,80 para
    // CREME DELICIA BOM confirmado! Seu pedido já foi anotado com o pagamento."
    // Uma foto não prova que o dinheiro caiu (comprovante falso, agendado, de
    // outro valor) — quem confirma é a loja ou o PIX automático, que não passa
    // por esta resposta. Só olha a fala livre da IA (sem ação): as mensagens do
    // próprio sistema sobre PIX não entram aqui.
    if (acaoMatch === null) {
      const trecho = resposta.match(/\b(pagamento|pix|transfer[eê]ncia|dep[oó]sito)\b[^\n.!?]{0,60}\b(confirmad[oa]|aprovad[oa]|recebid[oa]|compensad[oa]|caiu)\b|\bconfirm(ei|amos)\b[^\n.!?]{0,20}\b(o |seu )?(pagamento|pix)\b|\bpedido (j[áa] )?(est[áa] )?pago\b/i)?.[0] ?? ""
      // "depois que o pagamento for confirmado" / "assim que o PIX cair" é
      // explicação do PIX automático, não confirmação.
      const condicional = /\b(for|ser|seja|assim que|depois que|quando|ap[oó]s|at[ée] que|se|precisa|aguard\w*|esper\w*)\b/i.test(trecho)
      const confirmouPagamento = !!trecho && !condicional
      if (confirmouPagamento) {
        console.log("[SafeNet] robô confirmou pagamento pela foto — resposta trocada:", resposta.slice(0, 160))
        resposta = "Recebi seu comprovante! 🙌\n\nA loja confere o pagamento e confirma seu pedido por aqui. Qualquer dúvida é só chamar! 😊"
      }
    }

    // Safety net: cliente ESCREVEU o endereço e o Claude não emitiu salvar_rua.
    // Sem isto o endereço só existia no texto da conversa — o cadastro ficava
    // vazio e a taxa era calculada sobre o nada.
    const salvarRuaJaExecutado = acaoMatch !== null && (() => {
      try { return JSON.parse(acaoMatch![1])?.tipo === "salvar_rua" } catch { return false }
    })()
    const ultimaDoBot = (mensagens.filter((m: any) => m.role === "assistant").pop()?.content ?? "").toLowerCase()
    const botPediuEndereco = /nome da rua|seu endere|preciso do seu endere|falta s[oó] o endere|sua \*?localiza/.test(ultimaDoBot)
    // Não depende só de o bot ter pedido: se o cliente mandou algo que É um
    // endereço ("Rua tal, 600, bairro"), grava do mesmo jeito. O modelo às
    // vezes desvia do assunto no meio e a mensagem boa do cliente se perdia.
    const pareceEndereco = PREFIXO_RUA.test(limparRotuloEndereco(text)) && /\d/.test(text)
    if (!salvarRuaJaExecutado && !carrinhoEndereco.rua && (botPediuEndereco || pareceEndereco)) {
      const end = lerEnderecoEscrito(text)
      if (end) {
        console.log(`[Endereco] safety net: rua="${end.rua}" num=${end.numero ?? "-"} bairro="${end.bairro ?? "-"}"`)
        // Cidade da LOJA quando ele não disse: sem cidade o mapa procura a rua
        // no Brasil inteiro e a taxa sai de qualquer lugar.
        const cidadeReal = await descobrirCidade(end.rua, end.bairro, empresa.estado ?? null, empresa.cidade ?? null)
        const r = await handleSalvarRua(
          supabase, empresaId, phone, end.rua, end.bairro,
          cidadeReal, empresa.estado ?? null,
        )
        resposta = r.resposta
        if (end.numero) {
          const n = await handleSalvarNumero(supabase, empresaId, phone, phoneLocal, end.numero, aceitaDelivery, pgtoOpcoes)
          resposta = n.resposta
        }
      }
    }

    // Safety net: usuário mandou número mas Claude não emitiu salvar_numero
    // Só dispara se: temos rua, falta número, bot tinha pedido o número, e não foi salvo ainda
    // ── Safety net: o endereço veio em PEDAÇOS ─────────────────────────────
    // Duas formas do mesmo caso: "600 Novo Amarante" numa mensagem só, e o
    // bairro sozinho depois da rua. Roda antes do safety net do número puro,
    // que só entende dígitos.
    {
      const ultimaBot = (mensagens.filter((m: any) => m.role === "assistant").pop()?.content ?? "").toLowerCase()
      const botPediuEndOuNum = /n[úu]mero|sua casa|bairro|nome da rua|seu endere|falta s[oó] o endere|sua \*?localiza/.test(ultimaBot)
      const t = text.trim()

      // "600 Novo Amarante" / "600, Novo Amarante"
      const numEBairro = t.match(/^(\d{1,5}[a-zA-Z]?)[\s,]+(.{3,40})$/)
      if (numEBairro && carrinhoEndereco.rua && !carrinhoEndereco.numero && botPediuEndOuNum
          && pareceNomeDeBairro(numEBairro[2])) {
        console.log(`[Endereco] pedaços: numero=${numEBairro[1]} bairro="${numEBairro[2]}"`)
        if (!carrinhoEndereco.bairro) {
          await handleSalvarBairro(supabase, empresaId, phone, numEBairro[2].trim())
          carrinhoEndereco.bairro = numEBairro[2].trim()
        }
        const r = await handleSalvarNumero(supabase, empresaId, phone, phoneLocal, numEBairro[1], aceitaDelivery, pgtoOpcoes)
        resposta = r.resposta
        carrinhoEndereco.numero = numEBairro[1]
      } else if (carrinhoEndereco.rua && !carrinhoEndereco.bairro && botPediuEndOuNum
                 && pareceNomeDeBairro(t)) {
        // Só o bairro, na mensagem seguinte à da rua.
        await handleSalvarBairro(supabase, empresaId, phone, t)
        carrinhoEndereco.bairro = t
        resposta = carrinhoEndereco.numero
          ? `✅ Anotado: *${carrinhoEndereco.rua}, ${carrinhoEndereco.numero}* — ${t}.` + "\n\n" +
            (aceitaDelivery
              ? "Prefere *entrega* 🚚 ou vai *retirar* na loja? 🏪"
              : `Como vai pagar: ${pgtoOpcoes}? 💳`)
          : `✅ Anotado o bairro *${t}*!` + "\n\n" + "Qual o *número* da sua casa? 😊"
      }
    }

    const isNumeroMsg = /^\d{1,5}[a-zA-Z]?$/.test(text.trim())
    const salvarNumeroJaExecutado = acaoMatch !== null && (() => {
      try { return JSON.parse(acaoMatch![1])?.tipo === "salvar_numero" } catch { return false }
    })()
    const ultimaMsgBot = (mensagens.filter((m: any) => m.role === "assistant").pop()?.content ?? "").toLowerCase()
    const botPediuNumero = /n[úu]mero|sua casa|apt|complemento/.test(ultimaMsgBot)
    if (isNumeroMsg && carrinhoEndereco.rua && !carrinhoEndereco.numero && !salvarNumeroJaExecutado && botPediuNumero) {
      console.log("[Numero] safety net para:", text)
      const resultado = await handleSalvarNumero(supabase, empresaId, phone, phoneLocal, text.trim(), aceitaDelivery, pgtoOpcoes)
      resposta = resultado.resposta
    }

    // Rede de segurança: cliente JÁ cadastrado NUNCA deve ser perguntado nome/e-mail.
    // O Haiku às vezes ignora a diretiva e pede o nome ao fechar — aqui o código corrige,
    // mandando pra próxima etapa certa (entrega/retirada ou pagamento).
    if (cliente?.nome && /(seu\s+\*?nome\*?|seu\s+\*?e-?mail\*?|qual\s+(é\s+|o\s+)*seu\s+\*?(nome|e-?mail))/i.test(resposta)) {
      const primeiro = String(cliente.nome).split(" ")[0]
      const escolheuEntrega = mensagens.some((m: any) => m.role === "user" && /\b(entrega|retirada|retirar)\b/i.test(m.content || ""))
      if (escolheuEntrega) {
        resposta = `Perfeito, ${primeiro}! 😊 Como vai pagar: ${pgtoOpcoes}? 💳`
      } else if (aceitaDelivery) {
        resposta = `Perfeito, ${primeiro}! 😊 Prefere *entrega* 🚚 ou vai *retirar* na loja? 🏪`
      } else {
        resposta = `Perfeito, ${primeiro}! 😊 Pode retirar em: *${empresaEndereco || empresaNome}*. Como vai pagar: ${pgtoOpcoes}? 💳`
      }
      console.log("[SafeNet] cliente cadastrado — troquei o pedido de nome pela próxima etapa")
    }

    // Rede de segurança INVERSA: cliente NOVO (sem cadastro) com a sacola já montada
    // NUNCA pode pular o CADASTRO. O Haiku às vezes vai direto pro "entrega/retirada"
    // ou "CEP" sem pedir o nome — aqui forçamos a coleta do nome. E-mail não é mais pedido.
    if (!cliente?.nome && carrinho.length > 0) {
      const histAssist = mensagens.filter((m: any) => m.role === "assistant").map((m: any) => (m.content ?? "").toLowerCase())
      const respAtual = (resposta ?? "").toLowerCase()
      const botJaPediuNome  = histAssist.some((c: string) => /seu\s*\*?nome/.test(c))    || /seu\s*\*?nome/.test(respAtual)
      const cadastrouAgora = acaoMatch !== null && (() => { try { return JSON.parse(acaoMatch![1])?.tipo === "cadastrar_cliente" } catch { return false } })()
      // Bot está tentando avançar (entrega/retirada/pagamento/CEP/resumo) sem ter feito o cadastro
      const respostaAvancou = /(prefere\s*\*?entrega|vai\s*\*?retirar|\bretirada\b|como vai pagar|forma de pagamento|seu\s*\*?cep|resumo do pedido)/i.test(respAtual)
      if (!cadastrouAgora && respostaAvancou) {
        if (!botJaPediuNome) {
          resposta = "⚡ Estamos com um sistema novo por aqui! Seu cadastro é rapidinho e *uma vez só* — no próximo pedido já não precisa. 😊\n\nPra começar, qual o seu *nome*?"
          console.log("[SafeNet] cliente novo — forcei a pergunta do NOME (Haiku pulou o cadastro)")
        }
      }
    }

    // ── Fechar com a sacola VAZIA ────────────────────────────────────────────
    // "Pode fechar" sem nada anotado seguia pro nome, endereço e pagamento — e
    // lá no fim o pedido não nascia. Melhor dizer agora o que falta.
    {
      const tipoAcao = (() => { try { return acaoMatch ? JSON.parse(acaoMatch[1])?.tipo : null } catch { return null } })()
      // "Prefere entrega?" fica de fora: é também a resposta pra "vocês entregam?".
      const avancando = /(seu\s*\*?nome|falta s[oó] o endere|como vai pagar|resumo do pedido)/i.test(resposta)
      if (carrinho.length === 0 && tipoAcao !== "atualizar_carrinho" && avancando) {
        const { data: sacolaAgora } = await supabase.from("whatsapp_carrinho")
          .select("items").eq("empresa_id", empresaId).eq("phone", phone).maybeSingle()
        if (!(sacolaAgora?.items ?? []).length) {
          resposta = "🛒 Sua sacola ainda está vazia — não consegui anotar nada até agora. 😕\n\nMe diz de novo o *produto* e a *quantidade* que eu coloco pra você!"
          console.log("[SafeNet] tentou avançar com a sacola vazia")
        }
      }
    }

    // ── O cliente respondeu o NOME e o cadastro não foi feito ─────────────────
    // O modelo às vezes só agradece ("Obrigado, Teste Robo! 😊") sem a ação:
    // a conversa parava ali, sem cadastro e sem próxima pergunta (teste 13/09).
    {
      const ultimaBotAntes = mensagens.filter((m: any) => m.role === "assistant").pop()?.content ?? ""
      const tipoAcao = (() => { try { return acaoMatch ? JSON.parse(acaoMatch[1])?.tipo : null } catch { return null } })()
      // Rajada "Lorena" + "Sim sim": quem responde é a última mensagem, e o
      // cadastro saía com o nome "Sim sim" (CDBom, 15/09/2026). Procura o nome
      // em todas as mensagens desde a pergunta.
      const nomeDigitado = nomeDaRajada(mensagens, text) ?? ""
      const pareceNome = !!nomeDigitado
      if (!cliente?.nome && carrinho.length > 0 && /seu\s*\*?nome/i.test(ultimaBotAntes) && !tipoAcao && pareceNome) {
        await handleCadastrarCliente(supabase, empresaId, phone, phoneLocal, nomeDigitado, null, SUPABASE_URL, SUPABASE_KEY, indicadorProfileId)
        cliente = { ...(cliente ?? {}), nome: nomeDigitado }
        resposta = textoDepoisDoCadastro(aceitaDelivery, empresaEndereco || empresaNome, pgtoOpcoes)
        console.log(`[SafeNet] nome respondido sem cadastrar_cliente — cadastrei "${nomeDigitado}"`)
      }
    }

    // ── "Vou buscar" na hora do endereço ─────────────────────────────────────
    // Depois do cadastro o robô pede o endereço. Quem vai RETIRAR respondia
    // "vou buscar" e ouvia "manda a localização quando estiver pronto" — o
    // pedido de retirada de cliente novo não andava.
    {
      const ultimaBotAntes = mensagens.filter((m: any) => m.role === "assistant").pop()?.content ?? ""
      const tipoAcao = (() => { try { return acaoMatch ? JSON.parse(acaoMatch[1])?.tipo : null } catch { return null } })()
      if (/falta s[oó] o endere/i.test(ultimaBotAntes) && RE_RETIRADA.test(text) && !carrinhoEndereco.rua && tipoAcao !== "fechar_pedido") {
        resposta = `✅ Beleza, você retira na loja! 🏪\n\nPode retirar em: *${empresaEndereco || empresaNome}*.\n\nComo vai pagar: ${pgtoOpcoes}? 💳`
        console.log("[SafeNet] cliente escolheu retirada no pedido de endereço")
      }
    }

    // Rede de segurança: garante o link do catálogo na mensagem de BOAS-VINDAS
    // (1ª resposta do bot nesta conversa), caso o modelo esqueça. SÓ na saudação —
    // não altera nada do resto do fluxo.
    const ehPrimeiraMsg = mensagens.filter((m: any) => m.role === "assistant").length === 0
    // Cliente recorrente já tem histórico, então "primeira msg" nunca dá true pra ele.
    // Também tratamos como saudação quando a resposta CUMPRIMENTA e o carrinho está vazio
    // (nenhum pedido em andamento) — assim o link aparece na saudação do cliente antigo também.
    const respSaudacao = /^\s*(oi|ol[áa]|opa|e a[íi]|bom dia|boa tarde|boa noite|seja bem|bem-?vind)/i.test(resposta || "") || /tudo bem\s*\?/i.test(resposta || "")
    const ehBoasVindas = ehPrimeiraMsg || (respSaudacao && carrinho.length === 0)
    if (ehBoasVindas && catalogoUrl && resposta && !resposta.includes("lojaonline.fwcinter.com")) {
      resposta = `${resposta}\n\n👉 ${catalogoUrl}`
      console.log("[SafeNet] link do catálogo adicionado na mensagem de boas-vindas")
    }

    // Resumo com "Pagamento: Como vai pagar…?" dentro: o modelo pulou a etapa do
    // pagamento e colou a pergunta no resumo (conversa real, 13/09). Pergunta
    // só o pagamento; o resumo vem depois, com ele escolhido.
    if (/resumo do pedido/i.test(resposta) && /como vai pagar/i.test(resposta)) {
      resposta = `Antes do resumo: como vai pagar — ${pgtoOpcoes}? 💳`
      console.log("[SafeNet] resumo sem pagamento escolhido — perguntei o pagamento")
    }

    // Preço errado ao lado do nome de um produto (balde de sorvete a R$ 125).
    if (!/resumo do pedido/i.test(resposta)) resposta = corrigirPrecosCitados(resposta, produtos,
      // Só conta como montado o produto em que a escolha MUDA o preço (borda,
      // sabor de pizza). Sabor de picolé a R$ 0 continua sendo conferido.
      new Set(Object.entries(regrasOpcao).filter(([, ops]) => Object.values(ops).some(o => o.preco > 0)).map(([id]) => id)))

    // TAXA JUNTO DO ENDEREÇO. "Vcs entregam na Redinha?" → endereço → e o valor
    // da taxa só saía no resumo; a cliente perguntou de novo e o atendente
    // respondeu na mão (CDBom, 15/09/2026). A taxa é calculada no começo da
    // mensagem, antes de o endereço existir — aqui lê o que acabou de ser salvo.
    if (aceitaDelivery && /^✅ Endereço salvo!/.test(resposta) && /\?\s*[🏪💳]\s*$/u.test(resposta)) {
      try {
        const { data: e } = await supabase.from("whatsapp_carrinho")
          .select("endereco_rua, endereco_numero, endereco_bairro, endereco_cidade, endereco_lat, endereco_lng")
          .eq("empresa_id", empresaId).eq("phone", phone).maybeSingle()
        if (e?.endereco_rua && e?.endereco_numero) {
          const cfg = acharBairroCfg(empresa.taxas_entrega_bairro, e.endereco_bairro)
          let linhaTaxa = ""
          if (cfg && cfg.entrega === false) {
            linhaTaxa = `😕 No bairro *${e.endereco_bairro}* a gente não está entregando.`
          } else {
            let taxa: number | null = cfg ? Number(cfg.taxa) || 0 : null
            if (taxa == null) {
              const ponto = e.endereco_lat != null && e.endereco_lng != null ? { lat: Number(e.endereco_lat), lng: Number(e.endereco_lng) } : null
              const endStr = [e.endereco_rua, e.endereco_numero, e.endereco_bairro, e.endereco_cidade].filter(Boolean).join(", ")
              taxa = await calcularTaxaEntregaKm(empresa, endStr, ponto)
            }
            // Taxa fixa só pra loja sem tabela: com tabela, mapa que não achou a
            // rua prometeria R$ 5 pra quem mora a 20 km.
            const temTabela = (empresa.taxas_entrega_km ?? []).length || (empresa.taxas_entrega_bairro ?? []).length
            if (taxa == null && !temTabela) taxa = taxaEntrega
            if (taxa != null) linhaTaxa = taxa > 0 ? `🚚 Taxa de entrega: *R$ ${taxa.toFixed(2).replace(".", ",")}*` : "🚚 Entrega *grátis*!"
          }
          if (linhaTaxa) {
            const corte = resposta.lastIndexOf("\n\n")
            resposta = `${resposta.slice(0, corte)}\n\n${linhaTaxa}${resposta.slice(corte)}`
          }
        }
      } catch (err: any) { console.error("[Taxa] junto do endereço:", err?.message) }
    }

    // RESUMO COM A CONTA DO SISTEMA. O modelo lê "a partir de 5: R$ 2,50" na
    // lista e aplica em 3 pacotes de gelo — o resumo dizia R$ 21,50 e o pedido
    // gravava R$ 29,00 (teste CDBom, 13/09). Itens e total saem da sacola salva.
    if (/resumo do pedido/i.test(resposta)) {
      const { data: sacola } = await supabase.from("whatsapp_carrinho")
        .select("items").eq("empresa_id", empresaId).eq("phone", phone).maybeSingle()
      const itensSacola = (sacola?.items ?? []) as any[]
      if (itensSacola.length) {
        const corrigido = corrigirResumo(resposta, itensSacola, Number(taxaEntregaCalc) || 0)
        if (corrigido !== resposta) console.log("[Resumo] itens/total reescritos pela sacola")
        resposta = corrigido
      }
    }

    // ÚLTIMA PENEIRA, logo antes de sair. Vem depois de todas as redes de
    // segurança de propósito: se qualquer uma delas deixar passar tripa de
    // sistema — bloco de ferramenta, JSON solto, um "ACAO:" esquecido — ela
    // morre aqui. O cliente não pode ler o avesso do robô (05/09).
    const respostaLimpa = limparRestosInternos(resposta)
    if (respostaLimpa !== resposta) {
      console.error("[Vazamento] resposta tinha formato interno e foi limpa:", resposta.slice(0, 200))
      resposta = respostaLimpa
    }

    // Negrito do WhatsApp é *um* asterisco. O "**Moreninha Napolitano**" do
    // modelo chegava com os asteriscos sobrando na tela do cliente.
    resposta = resposta.replace(/\*\*([^*\n]+)\*\*/g, "*$1*")

    if (!resposta) {
      resposta = "Desculpe, não entendi bem. Pode repetir? 😊"
    }

    // PRIMEIRO CONTATO: ninguém (robô ou loja) tinha falado com este número
    // antes desta resposta. Agenda o vídeo tutorial pra 5 min depois — o worker
    // tutorial-followup só manda se o cliente continuar calado (mig 0269).
    // A unique empresa+telefone garante uma vez só na vida.
    if (!retomada && !url.searchParams.get("test") && !mensagensRaw.some((m: any) => m.role === "assistant")) {
      await supabase.from("tutorial_followup").upsert({
        empresa_id: empresaId, phone,
        agendado_para: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      }, { onConflict: "empresa_id,phone", ignoreDuplicates: true }).then(() => {}, () => {})
    }

    // Salva resposta no histórico e desconta crédito sempre; em teste pula envio ao WhatsApp
    await Promise.all([
      supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "assistant", content: resposta }),
      espelharNoChat(supabase, empresaId, phone, resposta, "loja", true),
      supabase.rpc("descontar_credito_whatsapp", { p_empresa_id: empresaId }),
      acaoPromise,
    ])

    if (isTest) {
      return new Response(
        // extraMsgs vinha SÓ no caminho do Evolution: na Meta o código PIX era
        // montado, empurrado pra cá e morria aqui. O cliente via "⬇️ Código
        // PIX:" e nada embaixo — pedido fechado, pagamento impossível.
        JSON.stringify({ ok: true, resposta, extraMsgs, pixQr: pixQrParaCloud, pixNumero: pixNumeroParaCloud, _debug: { clienteNome, clienteAchado: !!cliente, clienteId: cliente?.id ?? null, enderecoCliente, profileGlobal, phoneLocal, phoneLocalNo9 } }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Em produção envia ao WhatsApp
    await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body:    JSON.stringify({ number: phone, text: resposta }),
    }).catch(e => console.error("[sendText] erro:", e))

    for (const msg of extraMsgs) {
      await fetch(`${EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body:    JSON.stringify({ number: phone, text: msg }),
      }).catch(e => console.error("[extraMsg] sendText erro:", e))
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } })

  } catch (err) {
    console.error("Webhook error:", err)
    return new Response("ok", { headers: corsHeaders })
  }
})
