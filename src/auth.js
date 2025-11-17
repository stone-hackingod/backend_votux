import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from './config/env.js';

export const authenticateUser = async (matricule, password, pool) => {
  try {
    // Logger uniquement l'événement, pas les données sensibles
    console.log('🔐 Tentative de connexion');

    // Chercher l'utilisateur dans la base de données
    const [users] = await pool.execute(
      'SELECT * FROM voters WHERE matricule = ? AND is_active = TRUE',
      [matricule]
    );

    // Si pas d'utilisateur trouvé, vérifier si c'est un admin
    if (users.length === 0) {
      const [admins] = await pool.execute(
        'SELECT * FROM administrators WHERE email = ? AND is_active = TRUE',
        [matricule]
      );

      if (admins.length === 0) {
        return { success: false, message: 'Utilisateur non trouvé' };
      }

      const admin = admins[0];
      
      // Vérifier le mot de passe admin
      const validPassword = await bcrypt.compare(password, admin.password_hash);
      
      if (!validPassword) {
        return { success: false, message: 'Mot de passe incorrect' };
      }

      // Générer le token JWT pour admin
      const token = jwt.sign(
        { 
          id: admin.id,
          email: admin.email,
          role: admin.role,
          fullName: admin.full_name,
          institution_id: admin.institution_id || null,
          type: 'admin'
        },
        env.JWT_SECRET,
        { expiresIn: env.JWT_EXPIRES_IN }
      );

      return {
        success: true,
        token,
        user: {
          id: admin.id,
          email: admin.email,
          fullName: admin.full_name,
          role: admin.role,
          institution_id: admin.institution_id || null,
          type: 'admin',
          isAdmin: true
        }
      };
    }

    // Utilisateur électeur trouvé
    const user = users[0];
    
    // Vérifier le mot de passe
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return { success: false, message: 'Mot de passe incorrect' };
    }

    // Générer le token JWT pour électeur
    const token = jwt.sign(
      { 
        id: user.id,
        matricule: user.matricule,
        role: 'voter',
        fullName: user.full_name,
        promotion: user.promotion,
        institution_id: user.institution_id || null,
        type: 'voter'
      },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    return {
      success: true,
      token,
      user: {
        id: user.id,
        matricule: user.matricule,
        fullName: user.full_name,
        role: 'voter',
        promotion: user.promotion,
        email: user.email,
        institution_id: user.institution_id || null,
        type: 'voter',
        isAdmin: false
      }
    };

  } catch (error) {
    // Logger l'erreur complète côté serveur
    console.error('❌ Erreur authentification:', error);
    // Ne pas exposer les détails de l'erreur au client
    return { 
      success: false, 
      message: 'Erreur lors de l\'authentification'
    };
  }
};

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Token d\'accès requis'
    });
  }

  jwt.verify(token, env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: 'Token invalide ou expiré'
      });
    }
    
    req.user = user;
    next();
  });
};