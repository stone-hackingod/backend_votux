import crypto from 'crypto';
import { env } from '../config/env.js';

export class VoteEncryption {
  static algorithm = 'aes-256-gcm';
  
  static encryptVote(voteData, electionId) {
    try {
      // Clé dérivée de manière sécurisée
      // env.ENCRYPTION_KEY est validé au démarrage et ne peut pas être undefined
      const key = crypto.scryptSync(
        env.ENCRYPTION_KEY, 
        electionId, 
        32
      );
      
      const iv = crypto.randomBytes(16);
      
      // Utilisation de createCipheriv (nouvelle API)
      const cipher = crypto.createCipheriv(this.algorithm, key, iv);
      
      let encrypted = cipher.update(JSON.stringify(voteData), 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      return {
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      };
    } catch (error) {
      throw new Error(`Erreur de chiffrement: ${error.message}`);
    }
  }

  static decryptVote(encryptedData, electionId, iv, authTag) {
    try {
      // env.ENCRYPTION_KEY est validé au démarrage et ne peut pas être undefined
      const key = crypto.scryptSync(
        env.ENCRYPTION_KEY,
        electionId,
        32
      );
      
      const decipher = crypto.createDecipheriv(
        this.algorithm, 
        key, 
        Buffer.from(iv, 'hex')
      );
      
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      
      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return JSON.parse(decrypted);
    } catch (error) {
      throw new Error(`Erreur de déchiffrement: ${error.message}`);
    }
  }

  static generateVoteHash(voterId, electionId, timestamp) {
    return crypto
      .createHash('sha256')
      .update(`${voterId}-${electionId}-${timestamp}-${crypto.randomBytes(8).toString('hex')}`)
      .digest('hex');
  }
}