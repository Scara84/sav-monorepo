import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import serverConfig from './config/server.config.js';
import routes from './routes/index.js';
import { generalLimiter } from './middlewares/rateLimiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialisation de l'application Express
const app = express();

// Trust proxy - nécessaire pour Vercel et express-rate-limit
app.set('trust proxy', 1);

// Configuration Helmet pour les headers de sécurité
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // Permet les ressources cross-origin pour OneDrive
  contentSecurityPolicy: false // Désactivé pour éviter les conflits avec les uploads
}));

// Configuration CORS
app.use(cors(serverConfig.cors));

// Rate limiting général
app.use('/api', generalLimiter);

// Middleware pour parser le JSON
app.use(express.json({ limit: serverConfig.bodyParser.limit }));
app.use(express.urlencoded({ 
  extended: serverConfig.bodyParser.extended, 
  limit: serverConfig.bodyParser.limit 
}));

// Middleware de logging des requêtes
app.use((req, res, next) => {
  const start = Date.now();
  const { method, originalUrl, ip } = req;
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${method} ${originalUrl} from ${ip} - ${res.statusCode} (${duration}ms)`);
  });
  
  next();
});

// Servir les fichiers statiques
app.use('/uploads', express.static(path.join(__dirname, '../../', serverConfig.static.uploads)));

// Routes de l'API
app.use('/api', routes);

// Route de santé
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    env: process.env.NODE_ENV
  });
});

// Gestion des erreurs 404
/*
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    error: 'Route non trouvée',
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});
*/

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);
  
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Erreur interne du serveur';
  const stack = serverConfig.isDev ? err.stack : undefined;
  
  res.status(statusCode).json({
    success: false,
    error: message,
    ...(stack && { stack })
  });
});

export default app;
