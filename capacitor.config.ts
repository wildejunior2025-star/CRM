import { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.fwcinter.app',
  appName: 'FWC Inter',
  webDir: 'dist',
  server: {
    // App é uma casca que carrega o portal do cliente ao vivo.
    // Assim, melhorias no site aparecem na hora, sem nova versão na Play.
    url: 'https://app.fwcinter.com',
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#1e1140',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#1e1140',
      showSpinner: false,
    },
  },
}

export default config
