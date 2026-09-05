// Guarda a foto e o áudio do WhatsApp pra loja ver no chat do gestor (mig 0242).
//
// Duas regras que explicam o resto do arquivo:
//
// 1. BAIXA NA HORA. A Meta e o Evolution só entregam o arquivo por um tempo
//    curto depois que a mensagem chega. Esperar alguém clicar em "baixar" é
//    garantir que metade não vai estar mais lá. Então o webhook salva sempre,
//    mesmo que ninguém abra a conversa.
//
// 2. VIVE 24 HORAS. O sistema é pra atender AGORA; quem precisa rever a foto de
//    ontem abre o WhatsApp, que é onde a conversa mora de verdade. É isso que
//    deixa o custo constante em vez de crescente — sem prazo, eu precisaria de
//    cota por loja e faxina por tamanho.

const HORAS_DE_VIDA = 24

const EXTENSAO: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
  "audio/wav": "wav", "audio/webm": "weba",
  "video/mp4": "mp4", "video/3gpp": "3gp",
  "application/pdf": "pdf",
}

export function tipoDaMidia(mimetype: string): "imagem" | "audio" | "video" | "documento" {
  const m = String(mimetype || "").toLowerCase()
  if (m.startsWith("image/")) return "imagem"
  if (m.startsWith("audio/")) return "audio"
  if (m.startsWith("video/")) return "video"
  return "documento"
}

/**
 * Sobe o arquivo no bucket `chat-midias` e devolve o caminho + quando ele vence.
 *
 * O caminho começa pelo empresa_id de propósito: é essa primeira pasta que a
 * política do storage compara pra decidir quem pode ver. Sem isso uma loja
 * enxergaria a foto do cliente da outra.
 *
 * Falhar aqui NUNCA pode derrubar o atendimento: o robô responde igual, a
 * mensagem entra na conversa igual, só fica sem o anexo.
 */
// deno-lint-ignore-next-line no-explicit-any
export async function guardarMidiaDoChat(
  supabase: any,
  empresaId: string,
  base64: string,
  mimetype: string,
): Promise<{ path: string; tipo: string; expiraEm: string } | null> {
  try {
    if (!empresaId || !base64) return null
    const mime = String(mimetype || "application/octet-stream").split(";")[0].trim()
    const ext = EXTENSAO[mime] ?? "bin"

    // base64 → bytes. O `atob` engasga com string gigante de uma vez só, então
    // vai em pedaços — áudio de dois minutos passa fácil de 1 MB.
    const cru = atob(base64)
    const bytes = new Uint8Array(cru.length)
    for (let i = 0; i < cru.length; i++) bytes[i] = cru.charCodeAt(i)

    const hoje = new Date().toISOString().slice(0, 10)
    const path = `${empresaId}/${hoje}/${crypto.randomUUID()}.${ext}`

    const { error } = await supabase.storage.from("chat-midias").upload(path, bytes, {
      contentType: mime,
      upsert: false,
    })
    if (error) {
      console.error("[midia] upload falhou:", error.message)
      return null
    }
    const expiraEm = new Date(Date.now() + HORAS_DE_VIDA * 60 * 60 * 1000).toISOString()
    console.log(`[midia] guardada ${path} (${Math.round(bytes.length / 1024)} KB, vence em ${HORAS_DE_VIDA}h)`)
    return { path, tipo: tipoDaMidia(mime), expiraEm }
  } catch (e) {
    console.error("[midia] erro:", (e as Error)?.message)
    return null
  }
}
