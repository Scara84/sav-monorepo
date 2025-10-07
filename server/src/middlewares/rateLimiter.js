import rateLimit from 'express-rate-limit';

/**
 * Rate limiter pour les endpoints d'upload
 * Limite à 50 requêtes par 15 minutes par IP
 */
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Max 50 requêtes par fenêtre
  message: {
    success: false,
    error: 'Trop de requêtes d\'upload. Veuillez réessayer dans 15 minutes.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Handler personnalisé pour les requêtes dépassant la limite
  handler: (req, res) => {
    console.warn(`Rate limit dépassé pour IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      error: 'Trop de requêtes. Veuillez réessayer plus tard.',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
    });
  }
});

/**
 * Rate limiter plus strict pour les endpoints sensibles
 * Limite à 20 requêtes par 15 minutes par IP
 */
export const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Max 20 requêtes par fenêtre
  message: {
    success: false,
    error: 'Trop de requêtes. Veuillez réessayer dans 15 minutes.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`Rate limit strict dépassé pour IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      error: 'Trop de requêtes. Veuillez réessayer plus tard.',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
    });
  }
});

/**
 * Rate limiter général pour tous les endpoints API
 * Limite à 100 requêtes par 15 minutes par IP
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requêtes par fenêtre
  message: {
    success: false,
    error: 'Trop de requêtes. Veuillez réessayer plus tard.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting pour le health check
    return req.path === '/health' || req.path === '/api/test';
  }
});

export default {
  uploadLimiter,
  strictLimiter,
  generalLimiter
};
