// Configuration du serveur
export default {
  // Configuration du port
  port: process.env.PORT || 3000,

  // Configuration CORS
  cors: {
    origin: [
      // Regex for all Vercel deployments (production and preview)
      /^https:\/\/sav-monorepo-.*\.vercel\.app$/,
      // Production domains
      'https://sav.fruitstock.eu',
      'https://www.sav.fruitstock.eu',
      // Local development
      'http://localhost:3000',
      'http://localhost:5173'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
  },

  // Configuration des logs
  logs: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || 'logs',
    filename: 'app.log',
    errorFilename: 'error.log'
  },

  // Configuration du body parser
  bodyParser: {
    limit: '10mb',
    extended: true
  },

  // Configuration des dossiers statiques
  static: {
    client: '../client/dist',
    uploads: 'uploads'
  },

  // Configuration du mode développement
  isDev: process.env.NODE_ENV !== 'production',
  isProd: process.env.NODE_ENV === 'production'
};
