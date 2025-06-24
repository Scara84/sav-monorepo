import 'dotenv/config';
import { ENV_VARS, SERVER, MS_GRAPH, ERROR_MESSAGES } from './constants.js';

// Vérifier les variables d'environnement requises
const missingVars = ENV_VARS.filter(envVar => !process.env[envVar]);
if (missingVars.length > 0) {
  console.error('ERREUR: Variables d\'environnement manquantes:', missingVars.join(', '));
  process.exit(1);
}

// Configuration Microsoft
const microsoftConfig = {
  clientId: process.env.MICROSOFT_CLIENT_ID,
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  tenantId: process.env.MICROSOFT_TENANT_ID,
  authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`,
  scopes: MS_GRAPH.SCOPES,
  drivePath: MS_GRAPH.DRIVE_PATH,
  uploadUrl: MS_GRAPH.UPLOAD_URL,
  folderUrl: MS_GRAPH.FOLDER_URL
};

// Configuration du serveur
const serverConfig = {
  port: SERVER.PORT,
  nodeEnv: SERVER.NODE_ENV,
  uploadLimit: '10mb',
  corsOptions: {
    origin: process.env.NODE_ENV === 'production' 
      ? process.env.CLIENT_URL 
      : 'http://localhost:3000',
    optionsSuccessStatus: 200
  }
};

// Configuration MSAL (Microsoft Authentication Library)
const msalConfig = {
  auth: {
    clientId: microsoftConfig.clientId,
    authority: microsoftConfig.authority,
    clientSecret: microsoftConfig.clientSecret,
    knownAuthorities: ['login.microsoftonline.com']
  },
  system: {
    loggerOptions: {
      loggerCallback(loglevel, message) {
        console.log(message);
      },
      piiLoggingEnabled: false,
      logLevel: 'Info'
    }
  }
};

const config = {
  microsoft: microsoftConfig,
  server: serverConfig,
  msal: msalConfig,
  errors: ERROR_MESSAGES
};

export default config;
