import rateLimit from 'express-rate-limit';

/**
 * Configuration des rate limiters pour différents endpoints
 */

// Rate limiter pour le login (strict)
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Déploiement: tolère un peu plus d'essais tout en restant protecteur
  max: 20, // 20 tentatives par IP / 15 min
  message: {
    success: false,
    message: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Ne pas compter les connexions réussies
});

// Rate limiter pour le vote (modéré)
export const voteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  // Déploiement: permettre des rafales courtes tout en bloquant l'abus
  max: 60, // 60 requêtes de vote/minute par IP (les routes de vote sont déjà protégées)
  message: {
    success: false,
    message: 'Trop de votes. Réessayez dans une minute.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});

// Rate limiter pour l'import CSV (strict)
export const csvImportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 30, // 30 imports par heure
  message: {
    success: false,
    message: 'Trop d\'imports CSV. Réessayez dans une heure.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter pour la création de comptes/admin
export const createAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 60, // 60 créations par heure
  message: {
    success: false,
    message: 'Trop de créations de comptes. Réessayez dans une heure.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter pour les endpoints d'activation
export const activationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 20, // 20 demandes d'activation par heure
  message: {
    success: false,
    message: 'Trop de demandes d\'activation. Réessayez dans une heure.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter général pour les API (protection de base)
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Déploiement: budget plus large pour l'admin et les écrans riches (listes, actions)
  max: 1000, // 1000 requêtes par 15 minutes et par IP
  message: {
    success: false,
    message: 'Trop de requêtes. Réessayez dans quelques minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Ne pas limiter les health checks
    if (req.method === 'OPTIONS') return true; // pré‑requêtes CORS
    if (req.path === '/api/health' || req.path === '/api/test-db') return true;
    // Éviter de compter des endpoints de documentation / assets (si présents)
    if (req.path.startsWith('/api/docs')) return true;
    return false;
  }
});

