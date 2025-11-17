/**
 * Utilitaire de validation de la force des mots de passe
 */

export class PasswordValidator {
  /**
   * Valide la force d'un mot de passe
   * @param {string} password - Le mot de passe à valider
   * @returns {{ valid: boolean, errors: string[] }} - Résultat de la validation
   */
  static validate(password) {
    const errors = [];

    if (!password || typeof password !== 'string') {
      return { valid: false, errors: ['Le mot de passe est requis'] };
    }

    // Longueur minimale
    if (password.length < 8) {
      errors.push('Le mot de passe doit contenir au moins 8 caractères');
    }

    // Longueur maximale (protection contre DoS)
    if (password.length > 128) {
      errors.push('Le mot de passe ne peut pas dépasser 128 caractères');
    }

    // Au moins une majuscule
    if (!/[A-Z]/.test(password)) {
      errors.push('Le mot de passe doit contenir au moins une majuscule');
    }

    // Au moins une minuscule
    if (!/[a-z]/.test(password)) {
      errors.push('Le mot de passe doit contenir au moins une minuscule');
    }

    // Au moins un chiffre
    if (!/[0-9]/.test(password)) {
      errors.push('Le mot de passe doit contenir au moins un chiffre');
    }

    // Au moins un caractère spécial (optionnel mais recommandé)
    // Commenté pour ne pas être trop strict, mais peut être activé
    // if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    //   errors.push('Le mot de passe doit contenir au moins un caractère spécial');
    // }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Valide et lance une erreur si le mot de passe est invalide
   * @param {string} password - Le mot de passe à valider
   * @throws {Error} Si le mot de passe est invalide
   */
  static validateOrThrow(password) {
    const result = this.validate(password);
    if (!result.valid) {
      const error = new Error('Mot de passe invalide');
      error.name = 'ValidationError';
      error.errors = result.errors;
      throw error;
    }
  }
}

