const express = require('express');
const path = require('path');
const dotenv = require('dotenv');

// Charger les variables d'environnement du fichier .env si présent
dotenv.config();

const app = express();
const port = process.env.PORT || 3000; // Infomaniak fournira le PORT via process.env.PORT

// Servir les fichiers statiques du dossier 'dist'
app.use(express.static(path.join(__dirname, 'dist')));

// Pour toutes les autres requêtes GET non gérées par les fichiers statiques,
// renvoyer index.html pour que Vue Router puisse gérer le routage côté client.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => {
  console.log(`Serveur démarré sur le port ${port}`);
});
