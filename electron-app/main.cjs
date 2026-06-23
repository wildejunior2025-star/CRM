const { app, BrowserWindow, protocol } = require('electron')
const path = require('path')
const fs = require('fs')

// Registra o esquema "app://" como seguro (suporte a fetch, cookies, WebSocket)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      allowServiceWorkers: true,
      bypassCSP: true,
    },
  },
])

const MIME = {
  '.html':        'text/html',
  '.js':          'application/javascript',
  '.mjs':         'application/javascript',
  '.css':         'text/css',
  '.svg':         'image/svg+xml',
  '.png':         'image/png',
  '.jpg':         'image/jpeg',
  '.ico':         'image/x-icon',
  '.json':        'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2':       'font/woff2',
  '.woff':        'font/woff',
  '.ttf':         'font/ttf',
}

function getDistPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dist')
    : path.join(__dirname, '..', 'dist')
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    title: 'Painel de Pedidos',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  win.setMenuBarVisibility(false)

  // Carrega o app; o React Router redireciona para /login se não estiver logado,
  // e após o login volta para /painel automaticamente.
  win.loadURL('app://painel/painel')
}

app.whenReady().then(() => {
  const distPath = getDistPath()

  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    let filePath = path.join(distPath, url.pathname)

    // SPA fallback: qualquer rota desconhecida serve o index.html
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distPath, 'index.html')
    }

    const content = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mimeType = MIME[ext] || 'application/octet-stream'

    return new Response(content, {
      headers: { 'Content-Type': mimeType },
    })
  })

  createWindow()
})

app.on('window-all-closed', () => app.quit())
