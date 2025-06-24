import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const srcPath = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig(({ mode }) => {
  // Charge les variables d'environnement
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [vue()],
    // Configuration pour le build de production
    base: '',
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      emptyOutDir: true,
      sourcemap: false
    },
    server: {
      port: 5173,
      strictPort: true,
      open: true,
      proxy: {
        // Redirige les requêtes API vers le serveur backend
        '/api': {
          target: process.env.VITE_API_URL || 'http://localhost:3001',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '')
        }
      }
    },
    resolve: {
      alias: [
        {
          find: /^@\/(.*)/,
          replacement: `${srcPath}/$1`,
        },
        {
          find: /^@tests\/(.*)/,
          replacement: '<rootDir>/tests/$1',
        },
        {
          find: '@assets',
          replacement: `${srcPath}/assets`
        },
        {
          find: '@components',
          replacement: `${srcPath}/components`
        },
        {
          find: '@composables',
          replacement: `${srcPath}/composables`
        },
        {
          find: '@features',
          replacement: `${srcPath}/features`
        },
        {
          find: '@router',
          replacement: `${srcPath}/router`
        },
        {
          find: '@stores',
          replacement: `${srcPath}/stores`
        },
        {
          find: '@styles',
          replacement: `${srcPath}/styles`
        },
        {
          find: '@utils',
          replacement: `${srcPath}/utils`
        }
      ]
    }
  }
})
