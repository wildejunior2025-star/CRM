import { useCallback, useState } from 'react'
import Confirmar from '../components/Confirmar'

// Pergunta "tem certeza?" no visual do sistema, no lugar do confirm() feio do
// navegador. Devolve uma Promise<boolean>, então a troca no código é direta:
//
//   const [confirmar, avisoConfirmar] = useConfirmar()
//
//   async function excluir() {
//     const ok = await confirmar({
//       titulo: 'Excluir “Pizza Calabresa”?',
//       texto: 'Apaga o item do cardápio de vez — não dá pra desfazer.',
//       itens: ['3 Queijos', 'Camarão'],   // opcional: o que vai sumir
//       aviso: 'Se é só uma pausa, use o Pausar.',
//       textoOk: 'Sim, excluir',
//       perigo: false,                      // opcional: azul em vez de vermelho
//     })
//     if (!ok) return
//     ...
//   }
//
//   return (<div>{avisoConfirmar} …</div>)   // não esqueça de montar o aviso
export function useConfirmar() {
  const [pedido, setPedido] = useState(null)

  const confirmar = useCallback(
    (opcoes) => new Promise(resolve => setPedido({ ...opcoes, resolve })),
    [],
  )

  const responder = useCallback((resposta) => {
    setPedido(atual => { atual?.resolve(resposta); return null })
  }, [])

  const aviso = pedido ? <Confirmar pedido={pedido} onResposta={responder} /> : null
  return [confirmar, aviso]
}

export default useConfirmar
