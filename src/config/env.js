import dotenv from 'dotenv';

dotenv.config();

/**
 * Valide et retourne les variables d'environnement requises
 * Le serveur ne démarrera pas si les variables critiques sont manquantes
 */
function validateEnv() {
  const errors = [];

  // Variables critiques pour la sécurité
  if (!process.env.JWT_SECRET) {
    errors.push('JWT_SECRET est requis. Ne pas utiliser de valeur par défaut en production.');
  } else if (process.env.JWT_SECRET === 'secret_temp' || process.env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET doit être une chaîne sécurisée d\'au moins 32 caractères.');
  }

  if (!process.env.ENCRYPTION_KEY) {
    errors.push('ENCRYPTION_KEY est requis. Ne pas utiliser de valeur par défaut en production.');
  } else if (process.env.ENCRYPTION_KEY === 'default_encryption_key_32_bytes_long!' || process.env.ENCRYPTION_KEY.length < 32) {
    errors.push('ENCRYPTION_KEY doit être une chaîne sécurisée d\'au moins 32 caractères.');
  }

  // Variables de base de données
  if (!process.env.MYSQL_DATABASE) {
    errors.push('MYSQL_DATABASE est requis.');
  }

  if (!process.env.MYSQL_USER) {
    errors.push('MYSQL_USER est requis.');
  }

  // MongoDB est optionnel mais recommandé
  if (!process.env.MONGODB_URI && process.env.NODE_ENV === 'production') {
    errors.push('MONGODB_URI est requis en production.');
  }

  if (errors.length > 0) {
    console.error('❌ ERREURS DE CONFIGURATION:');
    errors.forEach(err => console.error(`  - ${err}`));
    console.error('\n💡 Créez un fichier .env à la racine du backend avec toutes les variables requises.');
    console.error('   Voir .env.example pour un exemple.\n');
    process.exit(1);
  }

  // Avertissements pour développement
  if (process.env.NODE_ENV !== 'production') {
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
      console.warn('⚠️  JWT_SECRET est trop court. Utilisez au moins 32 caractères en production.');
    }
    if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length < 32) {
      console.warn('⚠️  ENCRYPTION_KEY est trop court. Utilisez au moins 32 caractères en production.');
    }
  }
}

// Valider au chargement du module
validateEnv();

// Exporter les variables validées
export const env = {
  // Server
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3001', 10),
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:8080',
  FRONTEND_URLS: process.env.FRONTEND_URLS ? process.env.FRONTEND_URLS.split(',').map(s => s.trim()) : [],

  // Security (validées - ne peuvent pas être undefined)
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,

  // MySQL
  MYSQL_HOST: process.env.MYSQL_HOST || 'localhost',
  MYSQL_PORT: parseInt(process.env.MYSQL_PORT || '3306', 10),
  MYSQL_USER: process.env.MYSQL_USER || 'root',
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || '',
  MYSQL_DATABASE: process.env.MYSQL_DATABASE || 'votux',
  MYSQL_SSL: String(process.env.MYSQL_SSL || '').toLowerCase() === 'true',
  MYSQL_CONNECT_TIMEOUT: parseInt(process.env.MYSQL_CONNECT_TIMEOUT || '15000', 10),

  // MongoDB
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DB: process.env.MONGODB_DB,

  // Email
  SMTP_HOST: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  MAIL_FROM: process.env.MAIL_FROM || 'VOTUX <no-reply@localhost>',
};

