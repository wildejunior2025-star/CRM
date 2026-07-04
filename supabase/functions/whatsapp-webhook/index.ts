// Bot v181 — safety net: cliente cadastrado nunca é perguntado nome/email (troca pela próxima etapa) — corrige o Haiku pedindo nome de quem já é cliente
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

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
  rua: string
): Promise<{ resposta: string }> {
  try {
    const { error: ruaErr } = await supabase.from("whatsapp_carrinho").update({
      endereco_rua: rua,
      updated_at:   new Date().toISOString(),
    }).eq("empresa_id", empresaId).eq("phone", phone)
    if (ruaErr) console.error("[Rua] update erro:", ruaErr)

    return { resposta: `✅ Rua salva!\n\n📍 *Rua:* ${rua}\n\nQual o *número* da sua casa? 😊` }
  } catch (e: any) {
    console.error("[Rua] exceção:", e?.message ?? String(e))
    return { resposta: "Não consegui salvar a rua. Pode repetir?" }
  }
}

// ── handleSalvarNumero ───────────────────────────────────────────────────────
async function handleSalvarNumero(
  supabase: ReturnType<typeof createClient>,
  empresaId: string,
  phone: string,
  phoneLocal: string,
  numero: string,
  aceitaDelivery: boolean
): Promise<{ resposta: string }> {
  try {
    const { data: c } = await supabase
      .from("whatsapp_carrinho")
      .select("endereco_rua, endereco_bairro, endereco_cidade, endereco_estado")
      .eq("empresa_id", empresaId)
      .eq("phone", phone)
      .single()

    if (!c?.endereco_rua) {
      return { resposta: "Não encontrei o endereço salvo. Me manda o CEP de novo." }
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

    const localidade = [c.endereco_bairro, c.endereco_cidade, c.endereco_estado].filter(Boolean).join(" — ")
    const proximaPergunta = aceitaDelivery
      ? `Prefere *entrega* 🚚 ou vai *retirar* na loja? 🏪`
      : `Como vai pagar: *dinheiro* ou *cartão*? 💳`
    return {
      resposta: `✅ Endereço salvo!\n\n📍 *${c.endereco_rua}, ${numero}*\n${localidade}\n\n${proximaPergunta}`
    }
  } catch (e: any) {
    console.error("[Numero] exceção:", e?.message ?? String(e))
    return { resposta: "Não consegui salvar o número. Pode repetir?" }
  }
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
  carrinhoEndereco: { rua: string|null; numero: string|null; bairro: string|null; cidade: string|null },
  indicadorProfileId: string|null = null,
  taxaEntregaCalc: number|null = null
): Promise<{ mensagemExtra: string; acaoPromise: Promise<any>; pixCode?: string; bloqueioMensagem?: string }> {
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
    if (itens.length === 0) {
      console.error("[Pedido] abortado — carrinho vazio mesmo após re-fetch e fallback")
      return { mensagemExtra: "⚠️ Não encontrei itens no carrinho. Pode me falar novamente o que gostaria de pedir? 😊", acaoPromise: Promise.resolve() }
    }

    const taxaEntrega    = Number(empresa.taxa_entrega ?? 0)
    const tipoEntrega    = acao.tipo_entrega === "entrega" ? "entrega" : "retirada"
    const formaPgto      = acao.forma_pagamento ?? "dinheiro"

    const endRua    = acao.cliente_rua    ? String(acao.cliente_rua).trim()    : (carrinhoEndereco.rua    ?? cliente?.endereco ?? null)
    const endNumero = acao.cliente_numero ? String(acao.cliente_numero).trim() : (carrinhoEndereco.numero ?? cliente?.numero   ?? null)
    const endBairro = acao.cliente_bairro ? String(acao.cliente_bairro).trim() : (carrinhoEndereco.bairro ?? cliente?.bairro   ?? null)
    const endCidade = acao.cliente_cidade ? String(acao.cliente_cidade).trim() : (carrinhoEndereco.cidade ?? cliente?.cidade   ?? null)
    const endEstado = acao.cliente_estado ? String(acao.cliente_estado).trim() : (carrinhoEndereco.estado ?? cliente?.estado ?? null)

    if (tipoEntrega === "entrega" && !endRua) {
      return {
        mensagemExtra: "",
        acaoPromise: Promise.resolve(),
        bloqueioMensagem: "📍 Preciso do seu endereço para entrega!\n\nMe manda o seu *CEP* 👇",
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
    const taxaFinal      = tipoEntrega === "entrega" ? (taxaEntregaCalc != null ? taxaEntregaCalc : taxaEntrega) : 0
    const totalFinal     = totalCarrinho + taxaFinal

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
          }
        }),
      })
      if (!pixRes.ok) {
        console.error("[PIX] create-pix-payment falhou:", await pixRes.text())
        return { mensagemExtra: "⚠️ Erro ao gerar PIX. Tente cartão ou dinheiro.", acaoPromise: Promise.resolve() }
      }
      const pixData = await pixRes.json()
      await fetch(`${EVOLUTION_API_URL}/message/sendMedia/${instanceName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({
          number: phone, mediatype: "image",
          media: `data:image/png;base64,${pixData.qr_code_base64}`,
          caption: `📱 *QR Code PIX — Pedido #${pixData.numero_pedido ?? ""}*\n\n⏳ Você tem *5 minutos* para pagar.`,
        }),
      }).catch(e => console.error("[PIX] sendMedia erro:", e))
      const acaoPromise = supabase.from("whatsapp_carrinho").delete().eq("empresa_id", empresaId).eq("phone", phone)
      return { mensagemExtra: `\n\n✅ Assim que confirmado, seu pedido vai para a loja!\n\n⬇️ *Código PIX:*`, acaoPromise, pixCode: pixData.qr_code }
    }

    const pedidoPayload = {
      empresa_id: empresaId, cliente_id: clienteId, cliente_nome: clienteNomeInsert, cliente_telefone: clienteTel,
      endereco_rua: endRua, endereco_numero: endNumero, endereco_bairro: endBairro,
      endereco_cidade: endCidade, endereco_estado: endEstado,
      itens: itens, subtotal: totalCarrinho, taxa_entrega: taxaFinal, total: totalFinal,
      forma_pagamento: formaPgto, tipo_entrega: tipoEntrega,
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

    const acaoPromise    = supabase.from("whatsapp_carrinho").delete().eq("empresa_id", empresaId).eq("phone", phone)
    const numPedido      = pedidoNovo?.numero_pedido ?? ""
    const labelPgto      = formaPgto === "pix" ? "PIX" : formaPgto === "cartao" ? "cartão" : "dinheiro"
    const labelEntrega   = tipoEntrega === "entrega" ? "na entrega" : "na retirada"

    // Cliente só da loja — sem conta no app, sem credenciais/senha (sem mensagem de senha).

    mensagemExtra = `🧾 *Pedido #${numPedido} recebido!*\n\n💳 Pagamento em *${labelPgto}* ${labelEntrega}.\n\n⏳ Aguardando a loja confirmar — assim que confirmarem você recebe uma mensagem aqui! 🎉` + mensagemExtra
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

// ── Taxa de entrega por distância (mesma regra do gestor/PainelPedidos) ──────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
async function geocodificarEndereco(endereco: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const q = encodeURIComponent(`${endereco}, Brasil`)
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
      headers: { "User-Agent": "CRM-FWC/1.0" },
    })
    const data = await res.json()
    if (data?.[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
  } catch (e: any) { console.error("[Geo] erro:", e?.message) }
  return null
}
// Taxa (número) pela distância entre a loja e o endereço, ou null se não deu pra calcular.
async function calcularTaxaEntregaKm(empresa: any, endStr: string): Promise<number | null> {
  try {
    if (!empresa?.latitude || !empresa?.longitude) return null
    const faixas = Array.isArray(empresa.taxas_entrega_km) ? empresa.taxas_entrega_km : []
    if (faixas.length === 0) return null
    const coords = await geocodificarEndereco(endStr)
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

// ── serve ────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders })

  const url    = new URL(req.url)
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

  try {
    const payload = await req.json()
    if (payload.event !== "messages.upsert") return new Response("ok", { headers: corsHeaders })

    const msg = payload.data
    if (!msg || msg.key?.fromMe)                              return new Response("ok", { headers: corsHeaders })
    if (msg.key?.remoteJid?.endsWith("@g.us")) return new Response("ok", { headers: corsHeaders })

    const instanceName: string = payload.instance ?? ""
    if (!instanceName) return new Response("ok", { headers: corsHeaders })

    const phoneEarly = msg.key.remoteJid.replace("@s.whatsapp.net", "").replace(/\D/g, "")
    const isTest = url.searchParams.get("test") === "true"
      || req.headers.get("x-bot-test") === "1"
      || payload._test === true
      || phoneEarly === "5500000000001"

    let text = ""
    let imageBase64: string | null = null
    let imageMimetype = "image/jpeg"

    if (msg.messageType === "conversation" || msg.messageType === "extendedTextMessage") {
      text = (msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? "").trim()
      if (!text) return new Response("ok", { headers: corsHeaders })

    } else if (msg.messageType === "pttMessage" || msg.messageType === "audioMessage") {
      const media = await getMediaBase64(instanceName, msg)
      if (media?.base64) {
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

    } else if (msg.messageType === "imageMessage") {
      const caption = (msg.message?.imageMessage?.caption ?? "").trim()
      const media = await getMediaBase64(instanceName, msg)
      if (media?.base64) {
        imageBase64 = media.base64
        imageMimetype = media.mimetype?.split(";")?.[0] ?? "image/jpeg"
      }
      text = caption || "[imagem]"

    } else {
      return new Response("ok", { headers: corsHeaders })
    }

    const configRes = await supabase
      .from("whatsapp_config")
      .select("empresa_id, ia_ativo, ia_instrucoes, admin_phone, empresas(id, nome, slug, descricao, email_contato, chave_pix, pix_nome, taxa_entrega, pedido_minimo, taxas_entrega_km, raio_entrega_km, latitude, longitude, aceita_delivery, endereco, cidade, estado, cep, horario_abertura, horario_fechamento, horarios_funcionamento, indicador_profile_id, mp_conectado)")
      .eq("instance_name", instanceName)
      .eq("ativo", true)
      .single()

    const config = configRes.data
    if (!config?.ia_ativo) return new Response("ok", { headers: corsHeaders })

    const empresa        = (config.empresas as any) ?? {}
    const empresaId      = config.empresa_id
    const empresaNome    = empresa.nome ?? "Loja"
    const empresaSlug    = empresa.slug ?? ""
    const taxaEntrega    = Number(empresa.taxa_entrega ?? 0)
    const aceitaDelivery      = empresa.aceita_delivery ?? false
    // PIX no bot: só oferecido se a loja conectou o Mercado Pago dela (dinheiro cai na conta da loja,
    // pedido só vai pro painel após pagamento confirmado). Loja sem MP conectado: nada muda, segue dinheiro/cartão.
    const mpConectado         = empresa.mp_conectado === true
    const pgtoOpcoes          = mpConectado ? "*dinheiro*, *cartão* ou *PIX*" : "*dinheiro* ou *cartão*"
    const iaInstrucoes        = (config.ia_instrucoes ?? "").trim()
    const adminPhone          = (config.admin_phone ?? "").replace(/\D/g, "")
    const indicadorProfileId  = empresa.indicador_profile_id ?? null

    const empresaDescricao = empresa.descricao ?? ""
    const empresaEndereco  = [empresa.endereco, empresa.cidade, empresa.estado].filter(Boolean).join(", ")
    const empresaHorario   = empresa.horario_abertura && empresa.horario_fechamento
      ? `${empresa.horario_abertura} às ${empresa.horario_fechamento}`
      : empresa.horario_abertura ?? ""

    const catalogoUrl = empresaSlug
      ? `https://lojaonline.fwcinter.com/${empresaSlug}`
      : "https://lojaonline.fwcinter.com"

    const phone      = msg.key.remoteJid.replace("@s.whatsapp.net", "").replace(/\D/g, "")
    const phoneLocal = phone.replace(/^55/, "")
    const phoneLocalWith9 = phoneLocal.length === 10
      ? `${phoneLocal.slice(0, 2)}9${phoneLocal.slice(2)}`
      : phoneLocal
    // Variante SEM o 9 (BR): se veio com 9 (11 díg, 3º dígito 9), gera a versão de 10 díg.
    // Garante achar o cadastro salvo sem o 9 (Evolution às vezes entrega com, às vezes sem).
    const phoneLocalNo9 = phoneLocal.length === 11 && phoneLocal[2] === "9"
      ? `${phoneLocal.slice(0, 2)}${phoneLocal.slice(3)}`
      : phoneLocal

    const [creditRes] = await Promise.all([
      supabase.from("empresas").select("whatsapp_creditos").eq("id", empresaId).single(),
      supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "user", content: text }),
    ])
    if (!creditRes.data || creditRes.data.whatsapp_creditos <= 0) return new Response("ok", { headers: corsHeaders })

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
        const dia = grade[dow] as any
        const periodosHoje = ((dia?.aberto ? (dia.periodos ?? []) : []) as any[]).filter(p => p?.i && p?.f)
        lojaFechada = !periodosHoje.some(p => {
          const a = toMinH(p.i), b = toMinH(p.f)
          return a <= b ? (minutoAtual >= a && minutoAtual < b) : (minutoAtual >= a || minutoAtual < b)
        })
        if (periodosHoje.length) {
          horarioTexto = "Hoje atendemos das " + periodosHoje.map(p => `*${p.i}* às *${p.f}*`).join(" e ")
        } else {
          for (let k = 1; k <= 7; k++) {
            const nd = grade[(dow + k) % 7] as any
            const ps = ((nd?.aberto ? (nd.periodos ?? []) : []) as any[]).filter(p => p?.i && p?.f)
            if (ps.length) { horarioTexto = `Voltamos ${DIAS_SEM[(dow + k) % 7]} às *${ps[0].i}*`; break }
          }
        }
      } else if (empresa.horario_abertura && empresa.horario_fechamento) {
        const [aH, aM] = empresa.horario_abertura.slice(0, 5).split(":").map(Number)
        const [fH, fM] = empresa.horario_fechamento.slice(0, 5).split(":").map(Number)
        lojaFechada = minutoAtual < (aH * 60 + aM) || minutoAtual >= (fH * 60 + fM)
        horarioTexto = `Horário de atendimento: *${empresa.horario_abertura.slice(0, 5)}* às *${empresa.horario_fechamento.slice(0, 5)}*`
      }

      if (lojaFechada) {
        // Só avisa uma vez — se a última mensagem do bot já foi "fechado", ignora
        const { data: ultimaBotMsg } = await supabase
          .from("whatsapp_conversas")
          .select("content")
          .eq("empresa_id", empresaId).eq("phone", phone).eq("role", "assistant")
          .order("created_at", { ascending: false })
          .limit(1).maybeSingle()

        const jaAvisou = ultimaBotMsg?.content?.includes("Estamos fechados")
        if (!jaAvisou) {
          const msgFechado = `😴 Estamos fechados no momento!\n\n${horarioTexto || "Confira nosso cardápio"}.\n\nMas você já pode ver nosso cardápio e se planejar! 😊\n👉 ${catalogoUrl}`
          await supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "assistant", content: msgFechado })
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
        .select("role, content")
        .eq("empresa_id", empresaId)
        .eq("phone", phone)
        .order("created_at", { ascending: false })
        .limit(30),
      supabase.from("produtos")
        .select("id, nome, preco_venda, embalagem, categoria")
        .eq("empresa_id", empresaId)
        .eq("ativo", true)
        .order("nome")
        .limit(300),
      supabase.from("whatsapp_carrinho")
        .select("items, cliente_id, endereco_rua, endereco_numero, endereco_bairro, endereco_cidade, endereco_estado")
        .eq("empresa_id", empresaId)
        .eq("phone", phone)
        .single(),
      supabase.from("clientes")
        .select("id, nome, email, cep, numero, endereco, bairro, cidade, estado, telefone, created_at, origem")
        .eq("empresa_id", empresaId)
        .in("telefone", [...new Set([phone, phoneLocal, `0${phoneLocal}`, `55${phoneLocal}`, phoneLocalWith9, `55${phoneLocalWith9}`, phoneLocalNo9, `55${phoneLocalNo9}`])])
        .limit(1)
        .maybeSingle(),
    ])

    const mensagensRaw = (historicoRes.data ?? []).reverse()
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
    // Remove da listagem os produtos cuja categoria está FORA do horário de venda
    // agora (horário de Brasília). Categoria sem horário = sempre disponível.
    // Só filtra o cardápio — não muda mais nada do fluxo do bot. Como toda a
    // montagem (lista + complementos + preços) usa `produtos`, o filtro cobre tudo.
    const { data: catsHorario } = await supabase
      .from("categorias")
      .select("nome, hora_inicio, hora_fim")
      .eq("empresa_id", empresaId)
    const nowBRT = new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "America/Fortaleza", hour: "2-digit", minute: "2-digit" })
    const toMinBRT = (t: string) => { const [h, m] = String(t).slice(0, 5).split(":").map(Number); return h * 60 + m }
    const nowMinBRT = toMinBRT(nowBRT)
    const catForaHorario = new Set<string>()
    for (const c of ((catsHorario ?? []) as any[])) {
      if (!c.hora_inicio || !c.hora_fim) continue
      const a = toMinBRT(c.hora_inicio), b = toMinBRT(c.hora_fim)
      const disp = a <= b ? (nowMinBRT >= a && nowMinBRT < b) : (nowMinBRT >= a || nowMinBRT < b)
      if (!disp) catForaHorario.add(c.nome)
    }
    const produtos = ((produtosRes.data ?? []) as any[]).filter((p: any) => !p.categoria || !catForaHorario.has(p.categoria))

    // ── Complementos ("monte sua quentinha") — só dos produtos que têm grupos ──
    // Texto injetado no prompt para o bot listar categorias + máximo de cada.
    // Mapas de preço (verdade do banco) para recalcular o preço no servidor —
    // NUNCA confiar na conta feita pelo modelo.
    let complementosTexto = ""
    const precoBaseMap: Record<string, number> = {}   // produto_id → preço base
    const precoOpcaoMap: Record<string, number> = {}  // nome da opção (minúsculo) → adicional
    for (const p of produtos as any[]) precoBaseMap[p.id] = Number(p.preco_venda ?? 0)
    try {
      const produtoIds = produtos.map((p: any) => p.id)
      if (produtoIds.length) {
        const { data: gruposComp } = await supabase
          .from("complemento_grupos")
          .select("produto_id, nome, min, max, ordem, disponivel, complemento_opcoes(nome, preco_adicional, ordem, disponivel)")
          .in("produto_id", produtoIds)
        if (gruposComp && gruposComp.length) {
          const porProduto: Record<string, any[]> = {}
          for (const g of gruposComp as any[]) {
            if (g.disponivel === false) continue // grupo pausado: bot não oferece
            (porProduto[g.produto_id] ||= []).push(g)
            for (const o of (g.complemento_opcoes ?? [])) {
              precoOpcaoMap[String(o.nome).trim().toLowerCase()] = Number(o.preco_adicional ?? 0)
            }
          }
          const nomeDoProduto = (id: string) => produtos.find((p: any) => p.id === id)?.nome ?? ""
          const blocos: string[] = []
          for (const [pid, grupos] of Object.entries(porProduto)) {
            const linhas = (grupos as any[])
              .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
              .map((g: any) => {
                const ops = (g.complemento_opcoes ?? [])
                  .filter((o: any) => o.disponivel)
                  .sort((a: any, b: any) => (a.ordem ?? 0) - (b.ordem ?? 0))
                  .map((o: any) => Number(o.preco_adicional) > 0
                    ? `${o.nome} (+R$ ${Number(o.preco_adicional).toFixed(2)})`
                    : o.nome)
                  .join(", ")
                const quant = g.max > 1 ? `escolha até ${g.max}` : (g.min > 0 ? "escolha 1" : "opcional")
                return `  - ${g.nome} (${quant}): ${ops}`
              }).join("\n")
            blocos.push(`▸ ${nomeDoProduto(pid)}:\n${linhas}`)
          }
          complementosTexto = blocos.join("\n\n")
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
    }

    let cliente = clienteRes.data ?? null
    if (!cliente && clienteIdNoCarrinho) {
      const { data } = await supabase.from("clientes")
        .select("id, nome, email, cep, numero, endereco, bairro, cidade, estado, telefone, created_at, origem")
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

    // Taxa de entrega: calcula pela distância (faixas por km) quando já temos o endereço.
    // Cai na taxa fixa da loja se não der pra geocodificar / loja não tem faixas.
    let taxaEntregaCalc = taxaEntrega
    if (aceitaDelivery) {
      const endParaCalc = [
        carrinhoEndereco.rua ?? cliente?.endereco,
        carrinhoEndereco.numero ?? cliente?.numero,
        carrinhoEndereco.bairro ?? cliente?.bairro,
        carrinhoEndereco.cidade ?? cliente?.cidade,
      ].filter(Boolean).join(", ")
      if (endParaCalc) {
        const t = await calcularTaxaEntregaKm(empresa, endParaCalc)
        if (t != null) taxaEntregaCalc = t
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
${empresaHorario    ? `- Horário: ${empresaHorario}` : ""}
${empresa.chave_pix ? `- PIX: ${empresa.chave_pix} (${empresa.pix_nome ?? ""})` : ""}
CATÁLOGO: ${catalogoUrl}
${aceitaDelivery ? `ENTREGA: taxa R$ ${taxaEntregaCalc.toFixed(2)}${enderecoCliente ? " (já calculada pela distância do endereço do cliente)" : " (taxa base — pode mudar conforme a distância do endereço)"}` : "ENTREGA: somente retirada no local"}
FORMAS DE PAGAMENTO: ${mpConectado ? "Dinheiro, Cartão ou PIX. Se o cliente escolher PIX, o sistema gera o QR Code e o código copia-e-cola automaticamente ao fechar o pedido — o pedido só vai para a loja depois que o pagamento for confirmado. Você NÃO envia chave PIX manualmente." : "Dinheiro ou Cartão (PIX não disponível nesta loja pelo WhatsApp)"}

PRODUTOS DISPONÍVEIS:
${produtos.map((p: any) => `• ${p.nome} [id:${p.id}] — R$ ${Number(p.preco_venda).toFixed(2)} (${p.embalagem || "un"})`).join("\n") || "Nenhum produto cadastrado"}
${complementosTexto ? `\nPRODUTOS QUE SÃO MONTADOS COM COMPLEMENTOS (o cliente escolhe dentro de cada categoria):\n${complementosTexto}\n` : ""}
CARRINHO ATUAL: ${carrinho.length === 0 ? "Vazio" : `\n${carrinho.map((i: any) => {
  const comps = Array.isArray(i.complementos) && i.complementos.length ? ` (${i.complementos.map((c: any) => c.nome).join(", ")})` : ""
  return `• ${i.nome}${comps} x${i.qtd} = R$ ${(i.qtd * Number(i.preco)).toFixed(2)}`
}).join("\n")}\nSUBTOTAL: R$ ${totalCarrinho.toFixed(2)}`}
⚠️ No resumo (PASSO 6) use EXATAMENTE estes preços e este SUBTOTAL do CARRINHO ATUAL. Itens montados (quentinha) já têm os adicionais embutidos no preço — NUNCA use o preço base da lista de produtos nem recalcule.

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
Produto com complementos (Quentinha): siga o fluxo de complementos — mostre as categorias com os máximos e monte o item.
Continue somando itens até o cliente dizer que é só isso / que quer fechar.
⚠️ Enquanto monta a sacola, NUNCA peça nome, e-mail, CEP, endereço, entrega ou pagamento. Isso é SÓ depois que a sacola fechar.

▶ PASSO 3 — CADASTRO (só DEPOIS da sacola fechada, e só se CLIENTE = "Não cadastrado nesta loja")
Se o cliente JÁ tem nome em CLIENTE → PULE este passo inteiro, vá direto ao PASSO 4.
⚠️ GATILHO: assim que o cliente indicar que fechou a sacola ("é só isso", "pode fechar", "só isso mesmo", "fechar"), sua PRÓXIMA mensagem JÁ deve pedir o *nome* (item 1 abaixo). NÃO pergunte "quer mais algum item?" de novo, NÃO mostre resumo ainda. Se o cliente mandar o nome ou o e-mail por conta própria, ACEITE e siga a ordem — nunca responda "quer mais alguma coisa?".
Colete UM POR VEZ, nesta ordem exata:
  1. "Pra fechar seu pedido, qual o seu *nome*? 😊"
  2. Recebeu o nome → "E o seu *e-mail*? 📧"
  3. Recebeu o e-mail → emita cadastrar_cliente IMEDIATAMENTE (sem texto antes). O sistema pede o CEP em seguida.
  4. Recebeu o CEP → emita buscar_cep (sem texto antes). O sistema confirma o endereço e pede o número.
  5. Recebeu o número → emita salvar_numero. O sistema pergunta entrega/retirada automaticamente.
O telefone já temos (${phoneLocal}) — NUNCA peça.
⚠️ CRÍTICO: nome + e-mail são obrigatórios. Nunca pule um dos dois.

▶ PASSO 4 — ENTREGA OU RETIRADA
${aceitaDelivery
  ? `Pergunte: "Prefere *entrega* 🚚 ou vai *retirar* na loja? 🏪"\n\nSE ENTREGA:\n• SE já temos o endereço (ver CLIENTE, ou acabou de coletar no cadastro) → confirme: "Vou entregar em *[endereço]*. Está correto? 😊"\n  - Confirma → PASSO 5\n  - Quer trocar → peça o CEP (emita buscar_cep) e depois o número (emita salvar_numero)\n• SE ainda não temos endereço → peça o CEP (emita buscar_cep) e depois o número (emita salvar_numero), aí siga ao PASSO 5\n\nSE RETIRADA:\n• Informe: "Pode retirar em: *${empresaEndereco || empresaNome}*. ✅"\n• Vá ao PASSO 5`
  : `Somente retirada no local.\nInforme: "Pode retirar em: *${empresaEndereco || empresaNome}*. ✅"\nVá ao PASSO 5`}

▶ PASSO 5 — FORMA DE PAGAMENTO
"Como vai pagar: ${pgtoOpcoes}? 💳"
Aguarde a resposta.${mpConectado ? "\nSe escolher PIX: NÃO mande chave nem texto de pagamento — apenas siga para o resumo (PASSO 6) e, ao confirmar, emita fechar_pedido com forma_pagamento \"pix\". O sistema gera o QR e o copia-e-cola sozinho." : ""}

▶ PASSO 6 — RESUMO E CONFIRMAÇÃO
Após ter entrega/retirada E pagamento confirmados, envie o resumo completo:

"📋 *Resumo do pedido:*

[liste cada item: • Nome x qtd — R$ valor]
${aceitaDelivery ? `🚚 Taxa de entrega: R$ ${taxaEntregaCalc.toFixed(2)} (só se for entrega — use EXATAMENTE este valor)` : ""}
💰 *Total: R$ [total]*

📍 [Entrega em: endereço / Retirada em: endereço da loja]
💳 Pagamento: ${mpConectado ? "[dinheiro/cartão/PIX]" : "[dinheiro/cartão]"}

Confirma? 😊"

→ Cliente confirma → emita fechar_pedido IMEDIATAMENTE

▶ PASSO 7 — ACOMPANHAMENTO (automático — você NÃO faz nada aqui)
O sistema avisa sozinho quando a loja confirma o pedido, quando ele sai para entrega / fica pronto para retirada (mandando o *código* ao cliente) e quando é entregue (pedindo a avaliação de 1 a 5 ⭐).

══════════════════════════════════════
REGRAS IMPORTANTES
══════════════════════════════════════
1. NUNCA invente produtos ou preços — use APENAS a lista acima
2. NUNCA peça o telefone — já temos: ${phoneLocal}
3. NUNCA peça CEP se já temos o endereço do cliente (ver CLIENTE acima)
4. O resumo (PASSO 6) é OBRIGATÓRIO antes de fechar. NUNCA emita fechar_pedido sem antes mostrar o resumo e receber confirmação. E NUNCA mostre resumo/total ANTES de ter entrega/retirada E pagamento definidos — ao fechar a sacola, se o cliente não é cadastrado, a próxima coisa é pedir o NOME (PASSO 3), sem resumo ainda.
5. Colete nome e e-mail UM POR VEZ para clientes novos — e SÓ depois que a sacola estiver fechada (nunca durante a montagem)
6. CEP (8 dígitos): emita buscar_cep IMEDIATAMENTE, sem texto antes
7. NUNCA assuma forma de pagamento ou tipo de entrega sem perguntar nesta conversa
8. ⚠️ CRÍTICO — CARRINHO: toda vez que o cliente escolher um produto VOCÊ DEVE emitir ACAO: atualizar_carrinho com TODOS os itens. NUNCA diga "anotei" ou "adicionei" sem emitir esta ACAO. Sem ela o carrinho fica vazio e o pedido NÃO é criado.
9. NUNCA diga o que vai fazer antes de fazer. Proibido: "Deixa eu criar...", "Deixa eu fechar...", "Vou verificar...". Emita a ACAO diretamente — a confirmação vem automática. Se não há ACAO, termine sempre com uma pergunta.

══════════════════════════════════════
AÇÕES DISPONÍVEIS
══════════════════════════════════════

Atualizar carrinho (ao adicionar/remover produto — OBRIGATÓRIO ao confirmar produto escolhido):
ACAO: {"tipo": "atualizar_carrinho", "items": [{"produto_id": "ID_REAL", "nome": "Nome", "qtd": 1, "preco": 0.00}]}

▸ PRODUTO COM COMPLEMENTOS (ex.: Quentinha) — fluxo obrigatório:
  1. Quando o cliente escolher um produto que está na lista "PRODUTOS QUE SÃO MONTADOS COM COMPLEMENTOS", NÃO adicione direto. Primeiro mostre TODAS as categorias daquele produto, com as opções e quantos itens ele pode escolher em cada uma (ex.: "escolha 1", "escolha até 2"). Peça que ele diga o que quer em cada categoria.
  2. Respeite o máximo de cada categoria — nunca aceite mais opções do que o "escolha até N" permite. Mas se o cliente escolher menos do que o máximo permitido (ex.: 1 salada quando pode 2), está OK — NÃO fique insistindo para ele adicionar mais. Assim que ele disser as opções, emita atualizar_carrinho na hora.
  3. Assim que o cliente disser as opções (mesmo que junto com "só isso"), sua PRÓXIMA ação é emitir atualizar_carrinho com a quentinha montada. ⛔ NUNCA mostre uma lista de confirmação com ✓ ("Deixa eu confirmar sua Quentinha: • X ✓") antes de emitir — isso deixa o carrinho VAZIO e o pedido sai errado. Emita a ACAO direto; a confirmação vem automática do sistema.
     - "preco" = preço base do produto + a soma dos adicionais pagos (os que têm "+R$") escolhidos.
     - inclua SEMPRE "complementos": lista com o que ele escolheu, cada um {"nome": "opção", "qtd": 1}. Sem os complementos a cozinha não sabe o que fazer.
  ACAO: {"tipo": "atualizar_carrinho", "items": [{"produto_id": "ID_REAL", "nome": "Quentinha (M)", "qtd": 1, "preco": 17.00, "complementos": [{"nome": "Feijão Preto", "qtd": 1}, {"nome": "Arroz refogado", "qtd": 1}, {"nome": "Frango Assado", "qtd": 1}]}]}

Cadastrar cliente novo (após coletar nome E e-mail — PASSO 3, só depois da sacola fechada):
ACAO: {"tipo": "cadastrar_cliente", "nome": "[nome]", "email": "[email]"}
⚠️ Emita IMEDIATAMENTE após receber o e-mail. SEM texto antes. O sistema pede CEP em seguida.

Buscar endereço pelo CEP (quando cliente enviar o CEP):
ACAO: {"tipo": "buscar_cep", "cep": "59640000"}

Salvar rua (quando CEP não tinha logradouro):
ACAO: {"tipo": "salvar_rua", "rua": "Rua das Flores"}

Salvar número da casa:
ACAO: {"tipo": "salvar_numero", "numero": "42"}
⚠️ Após salvar, o sistema pergunta entrega/retirada automaticamente.

Fechar pedido — CLIENTE IDENTIFICADO (tem nome em CLIENTE acima, ou cadastrar_cliente foi emitido nesta sessão):
ACAO: {"tipo": "fechar_pedido", "tipo_entrega": "entrega", "forma_pagamento": "dinheiro", "cliente_rua": "[rua confirmada na conversa]", "cliente_numero": "[número confirmado]", "cliente_bairro": "[bairro]", "cliente_cidade": "[cidade]", "cliente_estado": "[estado]", "items": [{"produto_id": "ID_REAL", "nome": "Nome", "qtd": 1, "preco": 0.00}]}
[tipo_entrega: "entrega" ou "retirada" | forma_pagamento: ${mpConectado ? `"dinheiro", "cartao" ou "pix"` : `"dinheiro" ou "cartao"`}]
⚠️ SEMPRE inclua os "items" do carrinho atual E o endereço confirmado na conversa no ACAO fechar_pedido
⚠️ SE for retirada, omita os campos cliente_rua/numero/bairro/cidade/estado

Fechar pedido — CLIENTE SEM CADASTRO (raro: CLIENTE = "Não identificado" e cadastrar_cliente não foi emitido):
ACAO: {"tipo": "fechar_pedido", "tipo_entrega": "retirada", "forma_pagamento": "dinheiro", "cliente_nome": "[nome]", "cliente_email": "[email]", "cliente_telefone": "${phoneLocal}", "items": [{"produto_id": "ID_REAL", "nome": "Nome", "qtd": 1, "preco": 0.00}]}
⚠️ CRÍTICO: sem cliente_nome e cliente_email o pedido NÃO é criado

Escalar para humano (problema que a IA não resolve):
ACAO: {"tipo": "escalar_humano", "problema": "descrição"}
Após emitir: "Entendi! Já avisei a loja e em breve alguém entra em contato. 😊"
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
        max_tokens: 900,
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

    let acaoPromise: Promise<any> = Promise.resolve()
    let mensagemExtra             = ""
    const extraMsgs: string[]     = []

    if (acaoMatch) {
      if (acaoStart !== -1) resposta = resposta.slice(0, acaoStart).trim()
      try {
        const acao = JSON.parse(acaoMatch[1])

        if (acao.tipo === "atualizar_carrinho" && Array.isArray(acao.items)) {
          // Recalcula o preço no servidor (verdade do banco) — o modelo erra a conta.
          // preço = base do produto + soma dos adicionais das opções escolhidas.
          for (const it of acao.items) {
            const base = it.produto_id != null ? precoBaseMap[String(it.produto_id)] : undefined
            if (base != null) {
              let adicionais = 0
              for (const c of (Array.isArray(it.complementos) ? it.complementos : [])) {
                const add = precoOpcaoMap[String(c?.nome ?? "").trim().toLowerCase()]
                if (add) adicionais += add * Number(c?.qtd ?? 1)
              }
              const novo = +(base + adicionais).toFixed(2)
              if (novo !== Number(it.preco)) console.log(`[Preço] corrigido ${it.nome}: ${it.preco} → ${novo}`)
              it.preco = novo
            }
          }
          const carrinhoResult = await handleAtualizar_carrinho(supabase, empresaId, phone, acao.items)
          if (!carrinhoResult.ok) console.error("[Carrinho] falhou:", carrinhoResult)
          // Sempre substitui resposta do Haiku — evita "Vou adicionar..." (REGRA 10 não é respeitada pelo modelo)
          if (acao.items.length > 0) {
            const nomes = acao.items.map((i: any) => `${i.nome} x${i.qtd}`).join(", ")
            // Detalhe com os complementos escolhidos — pro cliente CONFERIR o que foi anotado
            // (se a IA anotou errado, ele corrige antes de fechar).
            const temComp = acao.items.some((i: any) => Array.isArray(i.complementos) && i.complementos.length > 0)
            const detalhe = acao.items.map((i: any) => {
              const comps = (Array.isArray(i.complementos) && i.complementos.length > 0)
                ? "\n" + i.complementos.map((c: any) => `   • ${c.nome}`).join("\n")
                : ""
              return `🍽️ *${i.nome}*${Number(i.qtd) > 1 ? ` x${i.qtd}` : ""}${comps}`
            }).join("\n\n")
            const cabecalho = temComp
              ? `✅ Anotei! Confere se está tudo certo:\n\n${detalhe}`
              : `✅ ${nomes} adicionado${acao.items.length > 1 ? "s" : ""} ao carrinho!`
            // Transição determinística: se o cliente já sinalizou fechar a sacola,
            // não pergunta "quer mais?" — segue direto para cadastro (se novo) ou entrega (se já cliente).
            const querFechar = /\b(pode fechar|só isso|so isso|é só isso|e so isso|só isso mesmo|so isso mesmo|fechar( o)? pedido|finaliza|encerra|é isso|e isso|pode mandar|pode confirmar)\b/i.test(text)
            if (querFechar && !cliente) {
              resposta = `${cabecalho}\n\nPra fechar seu pedido, qual o seu *nome*? 😊`
            } else if (querFechar && cliente) {
              resposta = aceitaDelivery
                ? `${cabecalho}\n\nPrefere *entrega* 🚚 ou vai *retirar* na loja? 🏪`
                : `${cabecalho}\n\nPode retirar em: *${empresaEndereco || empresaNome}*. Como vai pagar: ${pgtoOpcoes}? 💳`
            } else {
              resposta = `${cabecalho}\n\n${temComp ? "Está certo? " : ""}Deseja mais algum item ou pode fechar o pedido? 😊`
            }
          }

        } else if (acao.tipo === "verificar_cliente" && acao.busca) {
          const resultado = await handleVerificarCliente(
            supabase, empresaId, String(acao.busca), phone, phoneLocal, catalogoUrl, carrinho
          )
          if (resultado.resposta) {
            resposta = resultado.resposta
          } else {
            resposta += "\n\nNão encontrei seu cadastro ainda! Vou te cadastrar agora. 😊\n\nQual é o seu *e-mail*?"
          }
          if (resultado.cliente) cliente = resultado.cliente

        } else if (acao.tipo === "cadastrar_cliente" && acao.nome) {
          await handleCadastrarCliente(
            supabase, empresaId, phone, phoneLocal,
            String(acao.nome), acao.email ? String(acao.email) : null,
            SUPABASE_URL, SUPABASE_KEY, indicadorProfileId
          )
          // Após cadastro, coleta endereço antes de perguntar entrega/retirada
          resposta = `Me manda o seu *CEP* 😊`

        } else if (acao.tipo === "pedir_cep") {
          // sem ação — Claude já pediu o CEP na resposta

        } else if (acao.tipo === "buscar_cep" && acao.cep) {
          const resultado = await handleBuscarCep(supabase, empresaId, phone, String(acao.cep))
          resposta = resultado.resposta

        } else if (acao.tipo === "salvar_rua" && acao.rua) {
          const resultado = await handleSalvarRua(supabase, empresaId, phone, String(acao.rua))
          resposta = resultado.resposta

        } else if (acao.tipo === "salvar_numero" && acao.numero) {
          const resultado = await handleSalvarNumero(supabase, empresaId, phone, phoneLocal, String(acao.numero), aceitaDelivery)
          resposta = resultado.resposta

        } else if (acao.tipo === "fechar_pedido") {
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
            indicadorProfileId, taxaEntregaCalc
          )
          if (resultado.bloqueioMensagem) {
            resposta = resultado.bloqueioMensagem
          } else {
            // Ignorar texto vago do Haiku antes da ACAO — usar só a confirmação do sistema
            resposta    = resultado.mensagemExtra
            acaoPromise = resultado.acaoPromise
            if (resultado.pixCode) extraMsgs.push(resultado.pixCode)
          }

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
          c.includes("pix") || c.includes("cart") || c.includes("dinh")
        )
        const forma_pagamento = lastPayMsg?.includes("dinh") ? "dinheiro"
          : lastPayMsg?.includes("cart") ? "cartao"
          : (lastPayMsg?.includes("pix") && mpConectado) ? "pix"
          : "dinheiro"
        const userHist = userMsgs.join(" ")
        const tipo_entrega = userHist.includes("retirada") ? "retirada" : "entrega"
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
          indicadorProfileId, taxaEntregaCalc
        )
        if (!resultado.bloqueioMensagem) {
          acaoPromise = resultado.acaoPromise
          if (resultado.mensagemExtra) resposta = resultado.mensagemExtra
          if (resultado.pixCode) extraMsgs.push(resultado.pixCode)
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

    // Safety net: usuário mandou número mas Claude não emitiu salvar_numero
    // Só dispara se: temos rua, falta número, bot tinha pedido o número, e não foi salvo ainda
    const isNumeroMsg = /^\d{1,5}[a-zA-Z]?$/.test(text.trim())
    const salvarNumeroJaExecutado = acaoMatch !== null && (() => {
      try { return JSON.parse(acaoMatch![1])?.tipo === "salvar_numero" } catch { return false }
    })()
    const ultimaMsgBot = (mensagens.filter((m: any) => m.role === "assistant").pop()?.content ?? "").toLowerCase()
    const botPediuNumero = /n[úu]mero|sua casa|apt|complemento/.test(ultimaMsgBot)
    if (isNumeroMsg && carrinhoEndereco.rua && !carrinhoEndereco.numero && !salvarNumeroJaExecutado && botPediuNumero) {
      console.log("[Numero] safety net para:", text)
      const resultado = await handleSalvarNumero(supabase, empresaId, phone, phoneLocal, text.trim(), aceitaDelivery)
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
    // ou "CEP" sem pedir o nome/e-mail — aqui forçamos a coleta na ordem certa.
    if (!cliente?.nome && carrinho.length > 0) {
      const histAssist = mensagens.filter((m: any) => m.role === "assistant").map((m: any) => (m.content ?? "").toLowerCase())
      const respAtual = (resposta ?? "").toLowerCase()
      const botJaPediuNome  = histAssist.some((c: string) => /seu\s*\*?nome/.test(c))    || /seu\s*\*?nome/.test(respAtual)
      const botJaPediuEmail = histAssist.some((c: string) => /seu\s*\*?e-?mail/.test(c)) || /seu\s*\*?e-?mail/.test(respAtual)
      const cadastrouAgora = acaoMatch !== null && (() => { try { return JSON.parse(acaoMatch![1])?.tipo === "cadastrar_cliente" } catch { return false } })()
      // Bot está tentando avançar (entrega/retirada/pagamento/CEP/resumo) sem ter feito o cadastro
      const respostaAvancou = /(prefere\s*\*?entrega|vai\s*\*?retirar|\bretirada\b|como vai pagar|forma de pagamento|seu\s*\*?cep|resumo do pedido)/i.test(respAtual)
      if (!cadastrouAgora && respostaAvancou) {
        if (!botJaPediuNome) {
          resposta = "Pra fechar seu pedido, qual o seu *nome*? 😊"
          console.log("[SafeNet] cliente novo — forcei a pergunta do NOME (Haiku pulou o cadastro)")
        } else if (!botJaPediuEmail) {
          resposta = "E o seu *e-mail*? 📧"
          console.log("[SafeNet] cliente novo — forcei a pergunta do E-MAIL")
        }
      }
    }

    if (!resposta) {
      resposta = "Desculpe, não entendi bem. Pode repetir? 😊"
    }

    // Salva resposta no histórico e desconta crédito sempre; em teste pula envio ao WhatsApp
    await Promise.all([
      supabase.from("whatsapp_conversas").insert({ empresa_id: empresaId, phone, role: "assistant", content: resposta }),
      supabase.rpc("descontar_credito_whatsapp", { p_empresa_id: empresaId }),
      acaoPromise,
    ])

    if (isTest) {
      return new Response(
        JSON.stringify({ ok: true, resposta, _debug: { clienteNome, clienteAchado: !!cliente, clienteId: cliente?.id ?? null, enderecoCliente, profileGlobal, phoneLocal, phoneLocalNo9 } }),
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
