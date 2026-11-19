// ESPELHO DA CONVERSA NO GESTOR (mig 0238/0242)
//
// A loja abre a conversa no gestor e precisa ver as perguntas E as respostas.
// Sem isto ela via só o cliente falando sozinho, achava que ninguém tinha
// respondido — e respondia tudo de novo.
//
// Morava dentro do whatsapp-webhook. Saiu pra cá em 19/11/2026 porque a FILA
// de envio (whatsapp-fila) também precisa espelhar: mensagem que esperou a vez
// só aparece no chat quando sai de verdade, não quando entrou na fila.

// deno-lint-ignore-file no-explicit-any

export async function espelharNoChat(
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
