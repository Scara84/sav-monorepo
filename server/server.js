import 'dotenv/config';
import { createWriteStream } from 'fs';
import { access, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import app from './src/app.js';
import serverConfig from './src/config/server.config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const setupLogs = async () => {
  try {
    const logsDir = path.join(__dirname, serverConfig.logs.dir);
    await access(logsDir).catch(async () => {
      await mkdir(logsDir, { recursive: true });
    });

    const logStream = createWriteStream(path.join(logsDir, serverConfig.logs.filename), { flags: 'a' });
    const errorStream = createWriteStream(path.join(logsDir, serverConfig.logs.errorFilename), { flags: 'a' });

    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args) => {
      const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
      logStream.write(`[${new Date().toISOString()}] ${message}\n`);
      originalLog(...args);
    };

    console.error = (...args) => {
      const message = args.map(arg => arg instanceof Error ? `${arg.message}\n${arg.stack}` : typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
      errorStream.write(`[${new Date().toISOString()}] ${message}\n`);
      originalError(...args);
    };
  } catch (error) {
    originalError('Erreur lors de la configuration des logs:', error);
  }
};

const startServer = async () => {
  try {
    await setupLogs();

    const uploadsDir = path.join(__dirname, serverConfig.static.uploads);
    await access(uploadsDir).catch(async () => {
      await mkdir(uploadsDir, { recursive: true });
    });

    const server = app.listen(serverConfig.port, '0.0.0.0', () => {
      console.log(`\n=== Serveur démarré sur le port ${serverConfig.port} ===`);
    });

    const gracefulShutdown = () => {
      console.log('\nArrêt du serveur...');
      server.close(() => {
        console.log('Serveur arrêté.');
        process.exit(0);
      });
      setTimeout(() => {
        console.error('Arrêt forcé.');
        process.exit(1);
      }, 5000);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

  } catch (error) {
    console.error('Erreur au démarrage:', error);
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== 'test') {
  startServer();
}

// Exporter l'application et la fonction de démarrage
export { app, startServer };

export default app;