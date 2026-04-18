// Configuration du serveur
export default {
  // Configuration du port
  port: process.env.PORT || 3000,

  // Configuration CORS
  cors: {
    origin: (origin, callback) => {
      // Liste blanche des origins autorisées
      const allowedOrigins = [
        // Production domains
        'https://sav-fruitstock.vercel.app',
        'https://sav.fruitstock.eu',
        'https://www.sav.fruitstock.eu',
        // Local development
        'http://localhost:3000',
        'http://localhost:5173'
      ];

      // Regex pour les déploiements Vercel (production et preview)
      const vercelRegex = /^https:\/\/sav-monorepo-.*\.vercel\.app$/;

      if (!origin || allowedOrigins.includes(origin) || vercelRegex.test(origin)) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Origin non autorisée: ${origin}`);
        callback(new Error('CORS policy: origin not allowed'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Requested-With',
      'Accept',
      'Origin',
      'X-Client-Info',
      'X-Client-Reference'
    ],
    credentials: true,
    optionsSuccessStatus: 200
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
