import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Configuration MySQL
const dbConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'votux',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Créer le pool de connexions
export const pool = mysql.createPool(dbConfig);

// Tester la connexion
export const testConnection = async () => {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Connexion MySQL réussie!');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Erreur de connexion MySQL:', error.message);
    return false;
  }
};

// Exporter les utilitaires de base de données
export const db = {
  query: (sql, params) => pool.execute(sql, params),
  getConnection: () => pool.getConnection()
};