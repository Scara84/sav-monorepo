/**
 * Middleware d'authentification par API key
 * Vérifie que la requête contient une API key valide dans les headers
 */
export const authenticateApiKey = (req, res, next) => {
  // Récupérer l'API key depuis les headers
  const apiKey = req.header('X-API-Key') || req.header('Authorization')?.replace('Bearer ', '');
  
  // Vérifier si une API key est configurée dans les variables d'environnement
  const validApiKey = process.env.API_KEY;
  
  // Si aucune API key n'est configurée, on passe (pour dev local)
  if (!validApiKey) {
    if (process.env.NODE_ENV === 'production') {
      console.error('ERREUR CRITIQUE: API_KEY non configurée en production!');
      return res.status(500).json({
        success: false,
        error: 'Configuration du serveur incorrecte'
      });
    }
    // En dev, on log un warning mais on laisse passer
    console.warn('WARNING: API_KEY non configurée - authentification désactivée');
    return next();
  }
  
  // Vérifier que l'API key est fournie
  if (!apiKey) {
    console.warn(`Tentative d'accès sans API key depuis ${req.ip}`);
    return res.status(401).json({
      success: false,
      error: 'Authentification requise. Veuillez fournir une API key valide.',
      hint: 'Ajoutez le header "X-API-Key" à votre requête'
    });
  }
  
  // Vérifier que l'API key est valide
  if (apiKey !== validApiKey) {
    console.warn(`Tentative d'accès avec API key invalide depuis ${req.ip}`);
    return res.status(403).json({
      success: false,
      error: 'API key invalide. Accès refusé.'
    });
  }
  
  // API key valide, on continue
  console.log(`Accès autorisé avec API key valide depuis ${req.ip}`);
  next();
};

/**
 * Middleware d'authentification optionnelle
 * Vérifie l'API key si elle est fournie, mais n'empêche pas l'accès si elle ne l'est pas
 */
export const optionalAuth = (req, res, next) => {
  const apiKey = req.header('X-API-Key') || req.header('Authorization')?.replace('Bearer ', '');
  const validApiKey = process.env.API_KEY;
  
  if (apiKey && validApiKey && apiKey === validApiKey) {
    req.authenticated = true;
  } else {
    req.authenticated = false;
  }
  
  next();
};

export default {
  authenticateApiKey,
  optionalAuth
};
