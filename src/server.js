import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import helmet from 'helmet';
import { authenticateUser, authenticateToken } from './auth.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import Ballot from './models/Ballot.js';
import { VoteEncryption } from './utils/encryption.js';
import { env } from './config/env.js';
import { errorHandler, asyncHandler } from './middleware/errorHandler.js';
import { PasswordValidator } from './utils/passwordValidator.js';
import { 
  loginLimiter, 
  voteLimiter, 
  csvImportLimiter, 
  createAccountLimiter,
  activationLimiter,
  apiLimiter 
} from './middleware/rateLimiter.js';

// Validation des variables d'environnement (le module env.js fait déjà cette validation)

const app = express();
const PORT = env.PORT;

// Security headers and strong ETag (safe, no behavior change)
app.use(helmet());
app.set('etag', 'strong');

// Configuration MySQL
const dbConfig = {
  host: env.MYSQL_HOST,
  port: env.MYSQL_PORT,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: env.MYSQL_CONNECT_TIMEOUT,
  ssl: env.MYSQL_SSL ? { rejectUnauthorized: true } : undefined,
};

const pool = mysql.createPool(dbConfig);

// Ensure results table exists (for GET /results before any tally)
async function ensureResultsTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS election_results (
        id INT PRIMARY KEY AUTO_INCREMENT,
        election_id INT UNIQUE,
        total_votes INT DEFAULT 0,
        results_json JSON,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (e) {
    console.warn('⚠️  Impossible de créer la table election_results:', e.message);
  }
}

// --- Institution guards ---
function requireAdminWithInstitution(req, res, next) {
  if (!req.user || req.user.type !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
  }
  if (!req.user.institution_id) {
    return res.status(403).json({ success: false, message: "Administrateur non rattaché à une institution" });
  }
  next();
}

async function assertAdminCanAccessElection(req, res, electionId) {
  try {
    if (!req.user || req.user.type !== 'admin' || !req.user.institution_id) {
      res.status(403).json({ success: false, message: 'Accès refusé' });
      return false;
    }
    const [[row]] = await pool.execute('SELECT institution_id FROM elections WHERE id = ? LIMIT 1', [electionId]);
    if (!row) {
      res.status(404).json({ success: false, message: 'Scrutin non trouvé' });
      return false;
    }
    if (Number(row.institution_id) !== Number(req.user.institution_id)) {
      res.status(403).json({ success: false, message: 'Accès refusé pour cette institution' });
      return false;
    }
    return true;
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur autorisation', error: e.message });
    return false;
  }
}

// Ensure activation columns on voters table
async function ensureVoterActivationColumns() {
  try {
    await pool.execute(`
      ALTER TABLE voters
      ADD COLUMN IF NOT EXISTS activation_token VARCHAR(255) NULL,
      ADD COLUMN IF NOT EXISTS activation_expires DATETIME NULL
    `);
  } catch (e) {
    try {
      const [cols] = await pool.query("SHOW COLUMNS FROM voters LIKE 'activation_token'");
      if (cols.length === 0) {
        await pool.execute("ALTER TABLE voters ADD COLUMN activation_token VARCHAR(255) NULL");
      }
      const [cols2] = await pool.query("SHOW COLUMNS FROM voters LIKE 'activation_expires'");
      if (cols2.length === 0) {
        await pool.execute("ALTER TABLE voters ADD COLUMN activation_expires DATETIME NULL");
      }
    } catch (e2) {
      console.warn('⚠️  Migration voters activation columns:', e2.message);
    }
  }
}
ensureVoterActivationColumns();

// Kick off table check (non bloquant)
ensureResultsTable();

// Ensure election_admins mapping table exists
async function ensureElectionAdminsTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS election_admins (
        id INT PRIMARY KEY AUTO_INCREMENT,
        election_id INT NOT NULL,
        admin_id INT NOT NULL,
        UNIQUE KEY uniq_ea (election_id, admin_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (e) {
    console.warn('⚠️  Impossible de créer la table election_admins:', e.message);
  }
}
ensureElectionAdminsTable();

// Ensure election_public table for publishing voters list per election
async function ensureElectionPublicTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS election_public (
        id INT PRIMARY KEY AUTO_INCREMENT,
        election_id INT NOT NULL UNIQUE,
        published TINYINT(1) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (e) {
    console.warn('⚠️  Impossible de créer la table election_public:', e.message);
  }
}
ensureElectionPublicTable();

// Connect MongoDB
if (env.MONGODB_URI) {
  mongoose
    .connect(env.MONGODB_URI, { dbName: env.MONGODB_DB || undefined })
    .then(() => console.log('✅ MongoDB connecté'))
    .catch((err) => console.error('❌ Erreur MongoDB:', err.message));
} else {
  console.warn('⚠️  MONGODB_URI non défini, les bulletins ne seront pas stockés');
}

// --- Email (SMTP Brevo) ---
const smtpHost = env.SMTP_HOST;
const smtpPort = env.SMTP_PORT;
const smtpUser = env.SMTP_USER;
const smtpPass = env.SMTP_PASS;
const MAIL_FROM = env.MAIL_FROM;

let mailTransporter = null;
try {
  if (smtpUser && smtpPass) {
    mailTransporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

// Archiver un scrutin
app.post('/api/elections/:id/archive', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success:false, message:'Accès réservé aux administrateurs' });
    const electionId = Number(req.params.id);
    if (!electionId) return res.status(400).json({ success:false, message:'id invalide' });
    try { await pool.execute('ALTER TABLE elections ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0'); } catch {}
    await pool.execute('UPDATE elections SET archived = 1 WHERE id = ?', [electionId]);
    res.json({ success:true, message:'Scrutin archivé', electionId });
  } catch (error) {
    res.status(500).json({ success:false, message:'Erreur archivage', error: error.message });
  }
});

// Register archive/unarchive endpoints outside of SMTP block to ensure availability
app.post('/api/elections/:id/archive', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success:false, message:'Accès réservé aux administrateurs' });
    const electionId = Number(req.params.id);
    if (!electionId) return res.status(400).json({ success:false, message:'id invalide' });
    try { await pool.execute('ALTER TABLE elections ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0'); } catch {}
    await pool.execute('UPDATE elections SET archived = 1 WHERE id = ?', [electionId]);
    res.json({ success:true, message:'Scrutin archivé', electionId });
  } catch (error) {
    res.status(500).json({ success:false, message:'Erreur archivage', error: error.message });
  }
});

app.post('/api/elections/:id/unarchive', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success:false, message:'Accès réservé aux administrateurs' });
    const electionId = Number(req.params.id);
    if (!electionId) return res.status(400).json({ success:false, message:'id invalide' });
    try { await pool.execute('ALTER TABLE elections ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0'); } catch {}
    await pool.execute('UPDATE elections SET archived = 0 WHERE id = ?', [electionId]);
    res.json({ success:true, message:'Scrutin désarchivé', electionId });
  } catch (error) {
    res.status(500).json({ success:false, message:'Erreur désarchivage', error: error.message });
  }
});

// Désarchiver un scrutin
app.post('/api/elections/:id/unarchive', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success:false, message:'Accès réservé aux administrateurs' });
    const electionId = Number(req.params.id);
    if (!electionId) return res.status(400).json({ success:false, message:'id invalide' });
    try { await pool.execute('ALTER TABLE elections ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0'); } catch {}
    await pool.execute('UPDATE elections SET archived = 0 WHERE id = ?', [electionId]);
    res.json({ success:true, message:'Scrutin désarchivé', electionId });
  } catch (error) {
    res.status(500).json({ success:false, message:'Erreur désarchivage', error: error.message });
  }
});

// Résolution des égalités (admin)
app.post('/api/elections/:id/tie-break', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const electionId = Number(req.params.id);
    const { action, candidateIds, chosenCandidateId, note } = req.body || {};
    if (!electionId) return res.status(400).json({ success:false, message:'election id invalide' });
    if (!['second_round','random_draw','regulatory_decision'].includes(action)) {
      return res.status(400).json({ success:false, message:'action invalide' });
    }
    // S'assurer que la table d'audit existe
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS election_decisions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        election_id INT NOT NULL,
        decision_type VARCHAR(50) NOT NULL,
        payload_json JSON,
        decided_by INT,
        decided_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`);

    if (action === 'second_round') {
      if (!Array.isArray(candidateIds) || candidateIds.length < 2) {
        return res.status(400).json({ success:false, message:'candidateIds (>=2) requis pour second tour' });
      }
      // Cloner l'élection
      const [[orig]] = await pool.execute('SELECT * FROM elections WHERE id = ? LIMIT 1', [electionId]);
      if (!orig) return res.status(404).json({ success:false, message:'Scrutin introuvable' });
      const [ins] = await pool.execute(
        'INSERT INTO elections (title, description, start_date, end_date, is_public, max_votes, created_by, status, institution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`${orig.title} — Second tour`, orig.description, orig.start_date, orig.end_date, orig.is_public, orig.max_votes, req.user.id, 'draft', orig.institution_id || null]
      );
      const newElectionId = ins.insertId;
      // Copier uniquement les candidats ex aequo
      const [origCandidates] = await pool.execute('SELECT id, name, description, order_position FROM candidates WHERE election_id = ?', [electionId]);
      const toCopy = origCandidates.filter(c => candidateIds.includes(c.id));
      for (const c of toCopy) {
        await pool.execute('INSERT INTO candidates (election_id, name, description, order_position) VALUES (?, ?, ?, ?)', [newElectionId, c.name, c.description, c.order_position]);
      }
      // Journaliser
      await pool.execute('INSERT INTO election_decisions (election_id, decision_type, payload_json, decided_by) VALUES (?, ?, ?, ?)', [electionId, 'second_round', JSON.stringify({ candidateIds, newElectionId, note: note || null }), req.user.id]);
      return res.json({ success:true, message:'Second tour créé', newElectionId });
    }

    if (action === 'random_draw') {
      if (!Array.isArray(candidateIds) || candidateIds.length < 2) {
        return res.status(400).json({ success:false, message:'candidateIds (>=2) requis pour tirage' });
      }
      const seed = crypto.randomBytes(16).toString('hex');
      const index = crypto.randomInt(0, candidateIds.length);
      const winnerId = Number(candidateIds[index]);
      const [[cand]] = await pool.execute('SELECT name FROM candidates WHERE id = ? LIMIT 1', [winnerId]);
      const winnerName = cand ? cand.name : null;
      await pool.execute('UPDATE election_results SET winner_id = ?, winner_name = ? WHERE election_id = ?', [winnerId || null, winnerName, electionId]);
      await pool.execute('INSERT INTO election_decisions (election_id, decision_type, payload_json, decided_by) VALUES (?, ?, ?, ?)', [electionId, 'random_draw', JSON.stringify({ candidateIds, winnerId, seed, index, note: note || null }), req.user.id]);
      return res.json({ success:true, message:'Tirage au sort effectué', winner: { id: winnerId, name: winnerName } });
    }

    if (action === 'regulatory_decision') {
      const winnerId = Number(chosenCandidateId);
      if (!winnerId) return res.status(400).json({ success:false, message:'chosenCandidateId requis' });
      const [[cand]] = await pool.execute('SELECT name FROM candidates WHERE id = ? LIMIT 1', [winnerId]);
      if (!cand) return res.status(404).json({ success:false, message:'Candidat introuvable' });
      await pool.execute('UPDATE election_results SET winner_id = ?, winner_name = ? WHERE election_id = ?', [winnerId, cand.name, electionId]);
      await pool.execute('INSERT INTO election_decisions (election_id, decision_type, payload_json, decided_by) VALUES (?, ?, ?, ?)', [electionId, 'regulatory_decision', JSON.stringify({ chosenCandidateId: winnerId, note: note || null }), req.user.id]);
      return res.json({ success:true, message:'Décision réglementaire enregistrée', winner: { id: winnerId, name: cand.name } });
    }

    return res.status(400).json({ success:false, message:'Action non gérée' });
  } catch (error) {
    console.error('Erreur tie-break:', error);
    res.status(500).json({ success:false, message:'Erreur tie-break', error: error.message });
  }
});

// (moved) DEV only create-admin route is defined after express.json()

// Public: Get single institution by id
app.get('/api/institutions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: 'id invalide' });
    const [rows] = await pool.execute(
      'SELECT id, name, code, public_voters_enabled FROM institutions WHERE id = ? LIMIT 1',
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Institution non trouvée' });
    res.json({ success: true, institution: rows[0] });
  } catch (e) {
    console.error('Erreur institution par id:', e);
    res.status(500).json({ success: false, message: 'Erreur serveur', error: e.message });
  }
});

// --- DB ensure helpers for institutions/public list and voters.institution_id ---
async function ensureInstitutionsTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS institutions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        code VARCHAR(64) NULL UNIQUE,
        public_voters_enabled TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (e) {
    console.warn('ensureInstitutionsTable:', e.message);
  }
}

async function ensureInstitutionsPublicFlag() {
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM institutions LIKE 'public_voters_enabled'");
    if (cols.length === 0) {
      await pool.execute('ALTER TABLE institutions ADD COLUMN public_voters_enabled TINYINT(1) NOT NULL DEFAULT 0');
    }
  } catch (e) {
    console.warn('ensureInstitutionsPublicFlag:', e.message);
  }
}

async function ensureVotersInstitutionId() {
  try {
    // Add column if missing
    const [cols] = await pool.query("SHOW COLUMNS FROM voters LIKE 'institution_id'");
    if (cols.length === 0) {
      await pool.execute('ALTER TABLE voters ADD COLUMN institution_id INT NULL');
    }
  } catch (e) {
    console.warn('ensureVotersInstitutionId (add col):', e.message);
  }
  try {
    // Create index if missing
    const [idx] = await pool.query("SHOW INDEX FROM voters WHERE Key_name = 'idx_voters_institution_id'");
    if (idx.length === 0) {
      await pool.execute('CREATE INDEX idx_voters_institution_id ON voters (institution_id)');
    }
  } catch (e) {
    console.warn('ensureVotersInstitutionId (index):', e.message);
  }
}

async function ensureAdministratorsInstitutionId() {
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM administrators LIKE 'institution_id'");
    if (cols.length === 0) {
      await pool.execute('ALTER TABLE administrators ADD COLUMN institution_id INT NULL');
    }
  } catch (e) {
    console.warn('ensureAdministratorsInstitutionId (add col):', e.message);
  }

  try {
    // Create index if missing
    const [idx] = await pool.query("SHOW INDEX FROM administrators WHERE Key_name = 'idx_admins_institution_id'");
    if (idx.length === 0) {
      await pool.execute('CREATE INDEX idx_admins_institution_id ON administrators (institution_id)');
    }
  } catch (e) {
    console.warn('ensureAdministratorsInstitutionId (index):', e.message);
  }

  try {
    // Add FK only if not present
    const [fk] = await pool.query(`
      SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'administrators'
        AND COLUMN_NAME = 'institution_id' AND REFERENCED_TABLE_NAME = 'institutions'
    `);
    if (fk.length === 0) {
      await pool.execute('ALTER TABLE administrators ADD CONSTRAINT fk_admins_institution FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE SET NULL ON UPDATE CASCADE');
    }
  } catch (e) {
    console.warn('ensureAdministratorsInstitutionId (fk):', e.message);
  }
}

(async () => {
  try {
    await ensureInstitutionsTable();
    await ensureInstitutionsPublicFlag();
    await ensureVotersInstitutionId();
    await ensureAdministratorsInstitutionId();
  } catch (e) {
    console.warn('DB ensure columns (institutions/voters):', e.message);
  }
})();

// --- CSV utilities ---
function parseCSV(content) {
  // very small CSV parser supporting quoted fields and commas
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const parseLine = (line) => {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
        } else { cur += ch; }
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = parseLine(lines[0]).map(h => h.toLowerCase());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

function buildCSV(headers, rows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const head = headers.join(',');
  const body = rows.map(r => headers.map(h => esc(r[h])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

// (moved) CSV import route defined after body parsers

// --- Gestion des institutions partenaires ---
app.get('/api/institutions', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT id, name, code, public_voters_enabled 
      FROM institutions 
      ORDER BY name
    `);
    res.json({ success: true, institutions: rows });
  } catch (e) {
    console.error('Erreur liste institutions:', e);
    res.status(500).json({ success: false, message: 'Erreur serveur', error: e.message });
  }
});

// Endpoint pour l'admin d'une institution
app.get('/api/my-institution', authenticateToken, async (req, res) => {
  try {
    if (!req.user.institution_id) {
      return res.status(400).json({ success: false, message: 'Utilisateur non affilié à une institution' });
    }
    
    const [inst] = await pool.execute(
      'SELECT id, name, code, public_voters_enabled FROM institutions WHERE id = ?',
      [req.user.institution_id]
    );
    
    if (inst.length === 0) {
      return res.status(404).json({ success: false, message: 'Institution non trouvée' });
    }
    
    res.json({ success: true, institution: inst[0] });
  } catch (e) {
    console.error('Erreur récupération institution:', e);
    res.status(500).json({ success: false, message: 'Erreur serveur', error: e.message });
  }
});

// Activer/désactiver la liste publique (admin institution)
app.post('/api/my-institution/public-list', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin' || !req.user.institution_id) {
      return res.status(403).json({ success: false, message: 'Non autorisé' });
    }
    
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Paramètre enabled requis (boolean)' });
    }
    
    await pool.execute(
      'UPDATE institutions SET public_voters_enabled = ? WHERE id = ?',
      [enabled, req.user.institution_id]
    );
    
    res.json({ 
      success: true, 
      message: `Liste publique ${enabled ? 'activée' : 'désactivée'}` 
    });
  } catch (e) {
    console.error('Erreur mise à jour liste publique:', e);
    res.status(500).json({ success: false, message: 'Erreur serveur', error: e.message });
  }
});

// --- Export CSV (admin) ---
app.get('/api/voters/export', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success:false, message:'Accès réservé aux administrateurs' });
    const institutionId = req.query.institutionId ? Number(req.query.institutionId) : null;
    const institutionName = req.query.institution || null;
    let where = '';
    let params = [];
    if (institutionId) { where = 'WHERE v.institution_id = ?'; params = [institutionId]; }
    else if (institutionName) { where = 'WHERE i.name = ?'; params = [institutionName]; }
    const [rows] = await pool.execute(
      `SELECT v.matricule, v.full_name, v.email, v.promotion, i.name as institution
       FROM voters v LEFT JOIN institutions i ON v.institution_id = i.id ${where} ORDER BY v.matricule`, params);
    const headers = ['matricule','full_name','email','promotion','institution'];
    const csv = buildCSV(headers, rows.map(r=>({
      matricule: r.matricule,
      full_name: r.full_name,
      email: r.email || '',
      promotion: r.promotion || '',
      institution: r.institution || ''
    })));
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="voters.csv"');
    res.send('\uFEFF' + csv); // BOM for Excel
  } catch (e) {
    res.status(500).json({ success:false, message:'Erreur export CSV', error: e.message });
  }
});

// --- Public voters list (read-only, opt-in per institution) ---
app.get('/api/public/voters', async (req, res) => {
  try {
    const institutionId = req.query.institutionId ? Number(req.query.institutionId) : null;
    if (!institutionId) return res.status(400).json({ success:false, message:'institutionId requis' });
    const [inst] = await pool.execute('SELECT id, public_voters_enabled FROM institutions WHERE id = ? LIMIT 1', [institutionId]);
    if (inst.length === 0) return res.status(404).json({ success:false, message:'Institution introuvable' });
    if (!inst[0].public_voters_enabled) return res.status(403).json({ success:false, message:'Liste publique désactivée pour cette institution' });
    const [rows] = await pool.execute('SELECT full_name, promotion FROM voters WHERE institution_id = ? ORDER BY full_name', [institutionId]);
    // Public: no matricule, no email
    res.json({ success:true, institutionId, data: rows.map(r=>({
      full_name: r.full_name,
      promotion: r.promotion || ''
    }))});
  } catch (e) {
    res.status(500).json({ success:false, message:'Erreur liste publique', error:e.message });
  }
});

// Admin toggle public list per institution
app.post('/api/institutions/:id/public-list', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success:false, message:'Accès réservé aux administrateurs' });
    const id = Number(req.params.id);
    const enabled = Boolean(req.body?.enabled);
    await pool.execute('UPDATE institutions SET public_voters_enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
    res.json({ success:true, institutionId: id, enabled });
  } catch (e) {
    res.status(500).json({ success:false, message:'Erreur mise à jour publication', error:e.message });
  }
});

// CSV template
app.get('/api/voters/csv-template', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success:false, message:'Accès réservé aux administrateurs' });
    const headers = ['matricule','nom','prenom','email','institution','promotion'];
    const sample = [
      { matricule: '22M001', nom: 'Ndong', prenom: 'Paul', email: 'paul.ndong@example.com', institution: 'Université A', promotion: 'Licence 3' },
      { matricule: '22M002', nom: 'Mabika', prenom: 'Sarah', email: 'sarah.mabika@example.com', institution: 'Université A', promotion: 'Licence 3' },
      { matricule: '22M003', nom: 'Okoumba', prenom: 'Eric', email: '', institution: 'Université A', promotion: 'Licence 2' },
    ];
    const csv = buildCSV(headers, sample);
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition','attachment; filename="voters_template.csv"');
    res.send('\uFEFF' + csv);
  } catch (e) {
    res.status(500).json({ success:false, message:'Erreur template CSV', error:e.message });
  }
});
  }
} catch (e) {
  console.warn('⚠️  SMTP non initialisé:', e.message);
}

// Envoi d'un email
async function sendMail({ to, subject, html, text }) {
  if (!to) return;
  if (!mailTransporter) {
    console.log('✉️  SMTP non configuré. Simulation envoi:', { to, subject });
    return;
  }
  return await mailTransporter.sendMail({ from: MAIL_FROM, to, subject, html, text });
}

function buildActivationEmailHTML(activationLink, frontendBase, opts = {}) {
  const { recipientName, institutionName } = opts || {};
  const logoUrl = `${frontendBase}/votux_logo.png`;
  const helloLine = recipientName ? `Bonjour ${recipientName},` : 'Bonjour,';
  const instLine = institutionName ? `<div style="font-size:12px;opacity:.9">${institutionName}</div>` : '<div style="font-size:12px;opacity:.9">Vote Électronique Sécurisé</div>';
  return `
  <div style="background:#f6f8fb;padding:24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
      <tr>
        <td style="padding:20px 24px;border-bottom:1px solid #f1f5f9;background:#0ea5e9;color:#fff">
          <table width="100%"><tr>
            <td style="vertical-align:middle">
              <div style="font-size:18px;font-weight:700;letter-spacing:.2px">VOTUX</div>
              ${instLine}
            </td>
            <td align="right" style="vertical-align:middle">
              <img src="${logoUrl}" alt="VOTUX" width="40" height="40" style="display:block;border:0"/>
            </td>
          </tr></table>
        </td>
      </tr>
      <tr>
        <td style="padding:28px 24px 8px 24px">
          <h1 style="margin:0 0 8px 0;font-size:20px;line-height:28px;color:#0f172a">Activez votre compte</h1>
          <p style="margin:0 0 16px 0;font-size:14px;line-height:22px;color:#334155">${helloLine}</p>
          <p style="margin:0 0 16px 0;font-size:14px;line-height:22px;color:#334155">Merci d\'avoir rejoint VOTUX. Cliquez sur le bouton ci‑dessous pour activer votre compte. Ce lien est valable 24 heures.</p>
          <p style="margin:24px 0">
            <a href="${activationLink}" style="display:inline-block;background:#0ea5e9;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600">Activer mon compte</a>
          </p>
          <p style="margin:0 0 12px 0;font-size:12px;line-height:20px;color:#64748b">Si le bouton ne fonctionne pas, copiez et collez ce lien dans votre navigateur:</p>
          <p style="margin:0 0 24px 0;font-size:12px;line-height:18px;color:#0ea5e9;word-break:break-all">${activationLink}</p>
          <p style="margin:0;font-size:12px;line-height:18px;color:#94a3b8">Si vous n\'êtes pas à l\'origine de cette demande, ignorez cet e‑mail.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 24px 22px 24px;border-top:1px solid #f1f5f9;background:#f8fafc;color:#64748b;font-size:11px">
          VOTUX · Système de Vote Électronique Sécurisé
        </td>
      </tr>
    </table>
  </div>`;
}

// Middleware
// CORS: accepter plusieurs origines (local + LAN)
const defaultOrigins = ['http://localhost:8080', 'http://localhost:5173', 'http://127.0.0.1:5173'];
const envSingle = env.FRONTEND_URL ? [env.FRONTEND_URL] : [];
const allowedOrigins = Array.from(new Set([...defaultOrigins, ...envSingle, ...env.FRONTEND_URLS]));

console.log('🌐 CORS origins autorisés:', allowedOrigins);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // mobile apps/postman
    if (allowedOrigins.includes(origin)) return callback(null, true);
    // Autoriser automatiquement les IP LAN uniquement en développement
    if (env.NODE_ENV !== 'production') {
      const lanMatch = /^http:\/\/192\.168\.[0-9]{1,3}\.[0-9]{1,3}:(8080|5173)$/.test(origin);
      if (lanMatch) return callback(null, true);
    }
    return callback(new Error('Origin non autorisée par CORS'));
  },
  credentials: true,
}));
// Rate limiting global (appliqué à toutes les routes /api)
app.use('/api', apiLimiter);

app.use(express.json());
// Accept text bodies for CSV import (limite de 5mb + max 10000 lignes)
app.use(express.text({ type: ['text/plain', 'text/csv', 'text/*', 'application/octet-stream', 'application/vnd.ms-excel'], limit: '5mb' }));

// Publier / dépublier la liste électorale publique pour un scrutin (admin)
app.post('/api/elections/:id/publish-voters-list', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const electionId = Number(req.params.id);
    const { published } = req.body || {};
    if (!electionId) return res.status(400).json({ success:false, message:'election id invalide' });
    if (typeof published !== 'boolean') return res.status(400).json({ success:false, message:'published (boolean) requis' });
    await pool.execute(
      'INSERT INTO election_public (election_id, published) VALUES (?, ?) ON DUPLICATE KEY UPDATE published = VALUES(published)',
      [electionId, published ? 1 : 0]
    );
    res.json({ success:true, electionId, published });
  } catch (error) {
    res.status(500).json({ success:false, message:'Erreur publication liste électorale', error: error.message });
  }
});

// Liste publique des électeurs d'un scrutin (anonyme, lecture seule)
app.get('/api/elections/:id/public-voters', async (req, res) => {
  try {
    const electionId = Number(req.params.id);
    if (!electionId) return res.status(400).json({ success:false, message:'election id invalide' });
    // Vérifier publication
    const [pub] = await pool.execute('SELECT published FROM election_public WHERE election_id = ? LIMIT 1', [electionId]);
    if (pub.length === 0 || pub[0].published !== 1) {
      return res.status(404).json({ success:false, message:'Liste non publiée' });
    }
    // Récupérer les éligibles pour ce scrutin (nom + promotion uniquement)
    const [rows] = await pool.execute(
      `SELECT v.full_name, v.promotion
       FROM voting_records vr
       JOIN voters v ON v.id = vr.voter_id
       WHERE vr.election_id = ?
       ORDER BY v.full_name ASC`,
      [electionId]
    );
    const voters = rows.map(r => ({ full_name: r.full_name, promotion: r.promotion || '' }));
    res.json({ success:true, voters, count: voters.length });
  } catch (error) {
    res.status(500).json({ success:false, message:'Erreur liste publique électorale', error: error.message });
  }
});

// --- Import CSV voters (admin) --- (after body parsers)
app.post('/api/voters/import-csv', csvImportLimiter, authenticateToken, asyncHandler(async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    const sendEmails = String(req.query.sendEmails || 'true') === 'true';
    const contentType = (req.headers['content-type'] || '').toString();
    let csvText = '';
    if (typeof req.body === 'string') {
      csvText = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      csvText = req.body.toString('utf8');
    } else if (req.body && typeof req.body === 'object' && req.body.type === 'Buffer' && Array.isArray(req.body.data)) {
      try { csvText = Buffer.from(req.body.data).toString('utf8'); } catch {}
    } else if (req.body && typeof req.body.csvText === 'string') {
      csvText = req.body.csvText;
    } else if (/^text\//i.test(contentType) || /csv/i.test(contentType) || /octet-stream/i.test(contentType) || /vnd\.ms-excel/i.test(contentType)) {
      try { csvText = String(req.body || ''); } catch { csvText = ''; }
    }
    if (!csvText || csvText.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Envoyez le contenu CSV en text/plain ou text/csv dans le corps', contentType });
    }
    try {
      const firstLine = String(csvText).split(/\r?\n/)[0] || '';
      if (firstLine.includes(';') && !firstLine.includes(',')) {
        csvText = csvText.replace(/;/g, ',');
      }
    } catch {}

    if (csvText.charCodeAt(0) === 0xFEFF) {
      csvText = csvText.slice(1);
    }

    // Fallback if parseCSV is not in scope for any reason
    const _fallbackParseCSV = (content) => {
      const lines = String(content || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .filter(l => l.trim().length > 0);
      if (lines.length === 0) return { headers: [], rows: [] };
      const parseLine = (line) => {
        const out = []; let cur = ''; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (inQ) {
            if (ch === '"') { if (line[i+1] === '"') { cur += '"'; i++; } else { inQ = false; } }
            else { cur += ch; }
          } else {
            if (ch === '"') inQ = true; else if (ch === ',') { out.push(cur.trim()); cur=''; } else cur += ch;
          }
        }
        out.push(cur.trim());
        return out;
      };
      const headers = parseLine(lines[0]).map(h => h.toLowerCase());
      const rows = lines.slice(1).map(parseLine);
      return { headers, rows };
    };
    const parser = (typeof parseCSV === 'function') ? parseCSV : _fallbackParseCSV;
    const { headers, rows } = parser(csvText);
    
    // Limiter le nombre de lignes pour éviter DoS
    const MAX_CSV_ROWS = 10000;
    if (rows.length > MAX_CSV_ROWS) {
      return res.status(400).json({ 
        success: false, 
        message: `Le fichier CSV contient trop de lignes (${rows.length}). Maximum autorisé: ${MAX_CSV_ROWS}` 
      });
    }
    
    const normalize = (s='') => s
      .toString()
      .replace(/^\uFEFF/, '')
      .replace(/\u00A0/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .replace(/^"|"$/g, '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');

    const normalizedHeaders = headers.map(h => normalize(h));
    const headerAliases = new Map([
      ['matricule',['matricule','id','code']],
      ['nom',['nom','lastname','name']],
      ['prenom',['prenom','prénom','prenoms','first name','firstname']],
      ['email',['email','mail','courriel']],
      ['institution',['institution','etablissement','ecole','university']],
      ['promotion',['promotion','classe','niveau','annee','annee scolaire']]
    ]);
    const headerIndex = {};
    for (const [key, aliases] of headerAliases.entries()) {
      const idx = normalizedHeaders.findIndex(h => aliases.map(normalize).includes(h));
      if (idx >= 0) headerIndex[key] = idx;
    }

    const required = ['matricule','nom','prenom','email','institution','promotion'];
    const missing = required.filter(h => headerIndex[h] == null);
    if (missing.length > 0) {
      console.warn('CSV headers reçus:', headers);
      console.warn('CSV headers normalisés:', normalizedHeaders);
      return res.status(400).json({ success:false, message: 'En-têtes manquants', missing, received: headers });
    }

    const idx = headerIndex;
    const report = { processed: 0, inserted: 0, updated: 0, skipped: 0, errors: [] };

    for (const r of rows) {
      if (r.length === 1 && r[0] === '') continue;
      report.processed++;
      const matricule = (r[idx.matricule]||'').toString().trim();
      const nom = (r[idx.nom]||'').toString().trim();
      const prenom = (r[idx.prenom]||'').toString().trim();
      const email = (r[idx.email]||'').toString().trim();
      const instValueRaw = (r[idx.institution]||'').toString().trim();
      const promotion = (r[idx.promotion]||'').toString().trim();
      if (!matricule || !nom || !prenom || !instValueRaw) {
        report.skipped++; report.errors.push({ matricule, reason:'Champs requis manquants' }); continue;
      }
      const instCode = instValueRaw.toUpperCase();
      const instName = instValueRaw;
      const [instRows] = await pool.execute(
        'SELECT id, code, name, public_voters_enabled FROM institutions WHERE code = ? OR name = ? LIMIT 1',
        [instCode, instName]
      );
      if (instRows.length === 0) { report.skipped++; report.errors.push({ matricule, reason:`Institution inconnue: ${instValueRaw}` }); continue; }
      const institution_id = instRows[0].id;
      const full_name = `${nom} ${prenom}`.trim();
      const [existRows] = await pool.execute('SELECT id, email FROM voters WHERE matricule = ? LIMIT 1', [matricule]);
      if (existRows.length > 0) {
        await pool.execute('UPDATE voters SET full_name = ?, email = ?, promotion = ?, institution_id = ? WHERE id = ?', [full_name, email || null, promotion || null, institution_id, existRows[0].id]);
        report.updated++;
        continue;
      }
      const activationToken = crypto.randomBytes(24).toString('hex');
      const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3);
      await pool.execute(
        'INSERT INTO voters (matricule, full_name, email, promotion, is_active, activation_token, activation_expires, institution_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
        [matricule, full_name, email || null, promotion || null, activationToken, expires, institution_id]
      );
      report.inserted++;
      if (sendEmails && email && mailTransporter) {
        const activationLink = `${process.env.FRONTEND_URL || 'http://localhost:8080'}/activate/${activationToken}`;
        const html = buildActivationEmailHTML(activationLink, process.env.FRONTEND_URL || 'http://localhost:8080', { recipientName: full_name, institutionName: instRows[0]?.name });
        try { await sendMail({ to: email, subject: 'VOTUX – Activez votre compte', html, text: `Activez votre compte: ${activationLink}` }); } catch (e) { report.errors.push({ matricule, reason: 'Email non envoyé: ' + e.message }); }
        await new Promise(r => setTimeout(r, 200));
      }
    }

    res.json({ success: true, ...report });
  } catch (e) {
    // L'erreur sera gérée par le middleware errorHandler
    throw e;
  }
}));

// DEV only: create an admin quickly for a given institution
if (env.NODE_ENV !== 'production') {
  app.post('/api/dev/create-admin', createAccountLimiter, asyncHandler(async (req, res) => {
    try {
      const { email, full_name, password, institution_code, institution_id } = req.body || {};
      if (!email || !full_name || !password || (!institution_code && !institution_id)) {
        return res.status(400).json({ success: false, message: 'email, full_name, password et institution_code ou institution_id requis' });
      }
      let instId = Number(institution_id) || null;
      if (!instId) {
        const [[inst]] = await pool.execute('SELECT id FROM institutions WHERE code = ? LIMIT 1', [String(institution_code || '').toUpperCase()]);
        if (!inst) return res.status(404).json({ success: false, message: 'Institution non trouvée' });
        instId = inst.id;
      }
      
      // Valider la force du mot de passe
      const passwordValidation = PasswordValidator.validate(String(password));
      if (!passwordValidation.valid) {
        return res.status(400).json({ 
          success: false, 
          message: 'Mot de passe invalide',
          errors: passwordValidation.errors
        });
      }
      
      const password_hash = await bcrypt.hash(String(password), 10);
      const [exists] = await pool.execute('SELECT id FROM administrators WHERE email = ? LIMIT 1', [email]);
      if (exists.length > 0) {
        return res.status(409).json({ success: false, message: 'Un administrateur avec cet email existe déjà' });
      }
      const [ins] = await pool.execute(
        'INSERT INTO administrators (email, full_name, password_hash, institution_id) VALUES (?, ?, ?, ?)',
        [email, full_name, password_hash, instId]
      );
      res.json({ success: true, adminId: ins.insertId, email, full_name, institution_id: instId });
    } catch (e) {
      // L'erreur sera gérée par le middleware errorHandler
      throw e;
    }
  }));
}

// Rate limits sont maintenant importés depuis middleware/rateLimiter.js

// Vérifier SMTP au démarrage
(async () => {
  if (mailTransporter) {
    try {
      await mailTransporter.verify();
      console.log('✉️  SMTP prêt (vérification OK)');
    } catch (e) {
      console.warn('⚠️  SMTP verify a échoué:', e.message);
    }
  } else {
    console.warn('⚠️  SMTP non configuré (pas de transporter)');
  }
})();

// Test d'envoi d'email (admin seulement)
app.get('/api/dev/send-test-mail', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const to = req.query.to || process.env.TEST_MAIL_TO;
    if (!to) return res.status(400).json({ success: false, message: "Paramètre 'to' requis ou TEST_MAIL_TO absent" });
    const info = await sendMail({
      to,
      subject: 'VOTUX – Test d\'envoi',
      text: 'Ceci est un test d\'envoi depuis VOTUX',
      html: '<p>Ceci est un test d\'envoi depuis <strong>VOTUX</strong>.</p>'
    });
    res.json({ success: true, message: `Email de test envoyé à ${to}` , info });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Échec envoi test', error: e.message });
  }
});

// Diagnostics SMTP
app.get('/api/dev/diagnostics/mail', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const configured = Boolean(mailTransporter);
    let verify = null;
    if (mailTransporter) {
      try {
        await mailTransporter.verify();
        verify = { ok: true };
      } catch (e) {
        verify = { ok: false, error: e.message };
      }
    }
    res.json({
      success: true,
      configured,
      from: MAIL_FROM,
      host: smtpHost,
      port: smtpPort,
      user: smtpUser ? smtpUser.replace(/.(?=.{3})/g, '*') : null,
      verify
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur diagnostics SMTP', error: e.message });
  }
});

// Statut de vote de l'utilisateur courant pour un scrutin
app.get('/api/elections/:id/my-status', authenticateToken, async (req, res) => {
  try {
    const electionId = req.params.id;
    const voterId = req.user.id;
    const [rows] = await pool.execute(
      'SELECT has_voted, voted_at FROM voting_records WHERE election_id = ? AND voter_id = ? LIMIT 1',
      [electionId, voterId]
    );
    if (rows.length === 0) {
      return res.json({ eligible: false, hasVoted: false, votedAt: null });
    }
    return res.json({ eligible: true, hasVoted: rows[0].has_voted === 1, votedAt: rows[0].voted_at });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur lecture statut', error: error.message });
  }
});

// Activate voter account
app.post('/api/auth/activate', activationLimiter, asyncHandler(async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ success: false, message: 'token et password requis' });
    }

    const [[voter]] = await pool.execute(
      'SELECT id, activation_expires FROM voters WHERE activation_token = ? LIMIT 1',
      [token]
    );
    if (!voter) {
      return res.status(400).json({ success: false, message: 'Lien d\'activation invalide' });
    }
    if (voter.activation_expires && new Date(voter.activation_expires).getTime() < Date.now()) {
      return res.status(400).json({ success: false, message: 'Lien d\'activation expiré' });
    }

    // Valider la force du mot de passe
    const passwordValidation = PasswordValidator.validate(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ 
        success: false, 
        message: 'Mot de passe invalide',
        errors: passwordValidation.errors
      });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await pool.execute(
      'UPDATE voters SET password_hash = ?, is_active = TRUE, activation_token = NULL, activation_expires = NULL WHERE id = ?',
      [password_hash, voter.id]
    );

    res.json({ success: true, message: 'Compte activé' });
  } catch (error) {
    // L'erreur sera gérée par le middleware errorHandler
    throw error;
  }
}));

// Resend activation link
app.post('/api/voters/resend-activation', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const { email, voterId } = req.body || {};
    let voter;
    if (voterId) {
      const [[v]] = await pool.execute('SELECT v.id, v.email, v.is_active, v.full_name, i.name AS institution_name FROM voters v LEFT JOIN institutions i ON i.id = v.institution_id WHERE v.id = ?', [voterId]);
      voter = v;
    } else if (email) {
      const [[v]] = await pool.execute('SELECT v.id, v.email, v.is_active, v.full_name, i.name AS institution_name FROM voters v LEFT JOIN institutions i ON i.id = v.institution_id WHERE v.email = ?', [email]);
      voter = v;
    }
    if (!voter) return res.status(404).json({ success: false, message: 'Électeur introuvable' });
    if (voter.is_active) return res.status(400).json({ success: false, message: 'Compte déjà activé' });

    const activationToken = crypto.randomBytes(32).toString('hex');
    const activationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.execute(
      'UPDATE voters SET activation_token = ?, activation_expires = ? WHERE id = ?',
      [activationToken, activationExpires, voter.id]
    );

    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:8080';
    const activationLink = `${frontendBase}/activate/${activationToken}`;
    try {
      await sendMail({
        to: voter.email,
        subject: 'VOTUX – Lien d\'activation de votre compte',
        text: `Activez votre compte: ${activationLink}`,
        html: buildActivationEmailHTML(activationLink, frontendBase, { recipientName: voter.full_name, institutionName: (req.user && req.user.institution_name) || undefined })
      });
    } catch (e) {
      console.warn('⚠️  Envoi e-mail activation (renvoi) échoué:', e.message);
    }

    res.json({ success: true, message: 'Lien d\'activation renvoyé', activationLink });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur renvoi activation', error: error.message });
  }
});

// Route pour récupérer un scrutin par ID (normalisé) avec ses candidats
app.get('/api/elections/:id', authenticateToken, async (req, res) => {
  try {
    const electionId = req.params.id;
    const [[e]] = await pool.execute(
      `SELECT e.*, a.full_name as created_by_name
       FROM elections e
       LEFT JOIN administrators a ON e.created_by = a.id
       WHERE e.id = ?`,
      [electionId]
    );
    if (!e) {
      return res.status(404).json({ success: false, message: 'Scrutin non trouvé' });
    }
    // Institution guard for admins
    if (req.user?.type === 'admin' && req.user?.institution_id && Number(e.institution_id) !== Number(req.user.institution_id)) {
      return res.status(403).json({ success: false, message: 'Accès refusé pour cette institution' });
    }
    let status = e.status;
    if (!status || status === '') status = 'pending';
    if (status === 'draft') status = 'pending';
    if (status === 'active') status = 'ongoing';
    if (status === 'completed') status = 'closed';
    const [candidates] = await pool.execute(
      'SELECT * FROM candidates WHERE election_id = ? ORDER BY order_position',
      [electionId]
    );
    res.json({ ...e, status, candidates });
  } catch (error) {
    console.error('Erreur scrutin par ID:', error);
    res.status(500).json({ success: false, message: 'Erreur lors de la récupération du scrutin', error: error.message });
  }
});

// Détails d'un électeur (admin)
app.get('/api/voters/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const voterId = req.params.id;
    const [[voter]] = await pool.execute(
      'SELECT id, matricule, full_name, email, promotion, is_active FROM voters WHERE id = ?',
      [voterId]
    );
    if (!voter) return res.status(404).json({ success: false, message: 'Électeur introuvable' });
    res.json(voter);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur lecture électeur', error: error.message });
  }
});

// Mise à jour des infos d'un électeur (admin)
app.put('/api/voters/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const voterId = req.params.id;
    const { matricule, full_name, email, promotion, is_active } = req.body;
    const [[exists]] = await pool.execute('SELECT id FROM voters WHERE id = ?', [voterId]);
    if (!exists) return res.status(404).json({ success: false, message: 'Électeur introuvable' });
    // Unicité de matricule/email si fournis
    if (matricule) {
      const [dup] = await pool.execute('SELECT id FROM voters WHERE matricule = ? AND id <> ?', [matricule, voterId]);
      if (dup.length > 0) return res.status(409).json({ success: false, message: 'Ce matricule est déjà utilisé' });
    }
    if (email) {
      const [dup] = await pool.execute('SELECT id FROM voters WHERE email = ? AND id <> ?', [email, voterId]);
      if (dup.length > 0) return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé' });
    }
    await pool.execute(
      'UPDATE voters SET matricule = COALESCE(?, matricule), full_name = COALESCE(?, full_name), email = COALESCE(?, email), promotion = COALESCE(?, promotion), is_active = COALESCE(?, is_active) WHERE id = ?',
      [matricule ?? null, full_name ?? null, email ?? null, promotion ?? null, (typeof is_active === 'boolean' ? (is_active ? 1 : 0) : null), voterId]
    );
    const [[updated]] = await pool.execute('SELECT id, matricule, full_name, email, promotion, is_active FROM voters WHERE id = ?', [voterId]);
    res.json({ success: true, message: 'Électeur mis à jour', voter: updated });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur mise à jour électeur', error: error.message });
  }
});

// Réinitialisation/mise à jour du mot de passe d'un électeur (admin)
app.patch('/api/voters/:id/password', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const voterId = req.params.id;
    const { password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: 'Nouveau mot de passe requis' });
    
    // Valider la force du mot de passe
    const passwordValidation = PasswordValidator.validate(password);
    if (!passwordValidation.valid) {
      return res.status(400).json({ 
        success: false, 
        message: 'Mot de passe invalide',
        errors: passwordValidation.errors
      });
    }
    
    const [[exists]] = await pool.execute('SELECT id FROM voters WHERE id = ?', [voterId]);
    if (!exists) return res.status(404).json({ success: false, message: 'Électeur introuvable' });
    const password_hash = await bcrypt.hash(password, 10);
    await pool.execute('UPDATE voters SET password_hash = ? WHERE id = ?', [password_hash, voterId]);
    res.json({ success: true, message: 'Mot de passe mis à jour' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur mise à jour mot de passe', error: error.message });
  }
});

// Suppression d'un électeur (admin)
app.delete('/api/voters/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const voterId = req.params.id;
    // Nettoyage de ses enregistrements d'éligibilité
    await pool.execute('DELETE FROM voting_records WHERE voter_id = ?', [voterId]);
    const [del] = await pool.execute('DELETE FROM voters WHERE id = ?', [voterId]);
    if (del.affectedRows === 0) return res.status(404).json({ success: false, message: 'Électeur introuvable' });
    res.json({ success: true, message: 'Électeur supprimé' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur suppression électeur', error: error.message });
  }
});

// Retirer un électeur de la liste éligible d'un scrutin (admin)
app.delete('/api/elections/:id/eligible-voters/:voterId', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const electionId = req.params.id;
    const voterId = req.params.voterId;
    const [del] = await pool.execute('DELETE FROM voting_records WHERE election_id = ? AND voter_id = ?', [electionId, voterId]);
    if (del.affectedRows === 0) return res.status(404).json({ success: false, message: 'Éligibilité introuvable' });
    res.json({ success: true, message: 'Électeur retiré du scrutin' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur retrait électeur', error: error.message });
  }
});

// Lister tous les administrateurs (pour assignation aux scrutins)
app.get('/api/admins', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const [rows] = await pool.execute(
      'SELECT id, full_name, email, role, is_active FROM administrators ORDER BY full_name'
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur liste administrateurs', error: error.message });
  }
});

// Route pour clôturer un scrutin (status -> closed)
app.post('/api/elections/:id/close', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const electionId = req.params.id;
    if (!(await assertAdminCanAccessElection(req, res, electionId))) return;
    const [elections] = await pool.execute('SELECT * FROM elections WHERE id = ?', [electionId]);
    if (elections.length === 0) {
      return res.status(404).json({ success: false, message: 'Scrutin non trouvé' });
    }
    await pool.execute('UPDATE elections SET status = ? WHERE id = ?', ['completed', electionId]);
    res.json({ success: true, message: 'Scrutin clôturé' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur lors de la clôture du scrutin', error: error.message });
  }
});

// Récapitulatif d'un scrutin (éligibles, votants, status, dates)
app.get('/api/elections/:id/summary', authenticateToken, async (req, res) => {
  try {
    const electionId = req.params.id;
    // If admin, enforce institution scope
    if (req.user?.type === 'admin' && req.user?.institution_id) {
      if (!(await assertAdminCanAccessElection(req, res, electionId))) return;
    }
    const [[election]] = await pool.execute(
      'SELECT id, title, start_date, end_date, status FROM elections WHERE id = ?',
      [electionId]
    );
    if (!election) {
      return res.status(404).json({ success: false, message: 'Scrutin non trouvé' });
    }
    const [[eligible]] = await pool.execute(
      'SELECT COUNT(*) AS totalEligible FROM voting_records WHERE election_id = ?',
      [electionId]
    );
    const [[voted]] = await pool.execute(
      'SELECT COUNT(*) AS voted FROM voting_records WHERE election_id = ? AND has_voted = TRUE',
      [electionId]
    );
    // Short private cache to speed up repeated reads while authenticated
    res.set('Cache-Control', 'private, max-age=30');
    res.json({
      success: true,
      election,
      totalEligible: eligible.totalEligible || 0,
      voted: voted.voted || 0
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur résumé scrutin', error: error.message });
  }
});

// Suppression d'un scrutin et dépendances (admin)
app.delete('/api/elections/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const electionId = req.params.id;
    if (!(await assertAdminCanAccessElection(req, res, electionId))) return;

    const [exists] = await pool.execute('SELECT id FROM elections WHERE id = ?', [electionId]);
    if (exists.length === 0) {
      return res.status(404).json({ success: false, message: 'Scrutin non trouvé' });
    }

    // Supprimer dépendances MySQL
    await pool.execute('DELETE FROM voting_records WHERE election_id = ?', [electionId]);
    await pool.execute('DELETE FROM candidates WHERE election_id = ?', [electionId]);
    await pool.execute('DELETE FROM election_results WHERE election_id = ?', [electionId]);
    await pool.execute('DELETE FROM elections WHERE id = ?', [electionId]);

    // Supprimer bulletins Mongo
    try {
      await Ballot.deleteMany({ electionId: electionId.toString() });
    } catch (mongoErr) {
      console.warn('⚠️  Suppression bulletins Mongo échouée:', mongoErr.message);
    }

    res.json({ success: true, message: 'Scrutin supprimé avec succès' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur suppression scrutin', error: error.message });
  }
});
// voteLimiter est maintenant importé depuis middleware/rateLimiter.js

// Swagger UI (si fichier OpenAPI et dépendances dispos)
try {
  const openapiPath = path.join(process.cwd(), 'backend', 'docs', 'openapi.yaml');
  if (fs.existsSync(openapiPath)) {
    const yaml = await import('yaml');
    const doc = yaml.parse(fs.readFileSync(openapiPath, 'utf8'));
    const swaggerUiModule = await import('swagger-ui-express');
    const swaggerUi = swaggerUiModule.default;
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(doc));
    console.log(`📘 Swagger UI: http://localhost:${PORT}/api/docs`);
  }
} catch (e) {
  console.warn('⚠️  Swagger UI non initialisé:', e.message);
}

// Route de santé détaillée
app.get('/api/health', asyncHandler(async (req, res) => {
  const checks = {
    mysql: { status: false, message: 'Non connecté' },
    mongo: { status: false, message: 'Non connecté' },
    encryption: { status: false, message: 'Clé non configurée' },
    jwt: { status: false, message: 'Secret non configuré' },
  };

  // Vérifier MySQL
  try {
    const connection = await pool.getConnection();
    const [result] = await connection.execute('SELECT 1 as test');
    connection.release();
    checks.mysql = { status: true, message: 'Connecté', latency: 'OK' };
  } catch (error) {
    checks.mysql = { status: false, message: error.message };
  }

  // Vérifier MongoDB
  try {
    const state = mongoose.connection.readyState;
    if (state === 1) {
      checks.mongo = { status: true, message: 'Connecté', state: 'connected' };
    } else if (state === 2) {
      checks.mongo = { status: false, message: 'En cours de connexion', state: 'connecting' };
    } else if (state === 3) {
      checks.mongo = { status: false, message: 'Déconnexion en cours', state: 'disconnecting' };
    } else {
      checks.mongo = { status: false, message: 'Non connecté', state: 'disconnected' };
    }
  } catch (error) {
    checks.mongo = { status: false, message: error.message };
  }

  // Vérifier encryption key
  if (env.ENCRYPTION_KEY && env.ENCRYPTION_KEY.length >= 32) {
    checks.encryption = { status: true, message: 'Clé configurée', length: env.ENCRYPTION_KEY.length };
  }

  // Vérifier JWT secret
  if (env.JWT_SECRET && env.JWT_SECRET.length >= 32) {
    checks.jwt = { status: true, message: 'Secret configuré', length: env.JWT_SECRET.length };
  }

  // Déterminer le statut global
  const allCritical = checks.mysql.status && checks.encryption.status && checks.jwt.status;
  const status = allCritical ? 'healthy' : 'degraded';
  const emoji = allCritical ? '🟢' : (checks.mysql.status ? '🟠' : '🔴');

  res.json({
    project: 'VOTUX',
    status,
    emoji,
    version: '1.0.1',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: env.NODE_ENV,
    checks,
  });
}));

// Création d'un électeur (admin)
app.post('/api/voters', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }

    const { matricule, full_name, email, promotion, assignElectionId } = req.body;

    if (!matricule || !full_name) {
      return res.status(400).json({ success: false, message: 'matricule et full_name sont requis' });
    }

    // Unicité du matricule/email
    const [existMat] = await pool.execute('SELECT id FROM voters WHERE matricule = ?', [matricule]);
    if (existMat.length > 0) {
      return res.status(409).json({ success: false, message: 'Ce matricule existe déjà' });
    }
    if (email) {
      const [existEmail] = await pool.execute('SELECT id FROM voters WHERE email = ?', [email]);
      if (existEmail.length > 0) {
        return res.status(409).json({ success: false, message: 'Cet email existe déjà' });
      }
    }

    const activationToken = crypto.randomBytes(32).toString('hex');
    const activationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const [insert] = await pool.execute(
      'INSERT INTO voters (matricule, full_name, email, promotion, is_active, activation_token, activation_expires) VALUES (?, ?, ?, ?, FALSE, ?, ?)',
      [matricule, full_name, email || null, promotion || null, activationToken, activationExpires]
    );

    const newVoterId = insert.insertId;

    // Optionnel: assigner à un scrutin via voting_records
    if (assignElectionId) {
      await pool.execute(
        'INSERT IGNORE INTO voting_records (voter_id, election_id, has_voted) VALUES (?, ?, FALSE)',
        [newVoterId, assignElectionId]
      );
    }

    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:8080';
    const activationLink = `${frontendBase}/activate/${activationToken}`;
    try {
      if (email) {
        await sendMail({
          to: email,
          subject: 'VOTUX – Activez votre compte',
          text: `Activez votre compte: ${activationLink}`,
          html: buildActivationEmailHTML(activationLink, frontendBase, { recipientName: full_name })
        });
      }
    } catch (e) {
      console.warn('⚠️  Envoi e-mail activation (création) échoué:', e.message);
    }

    res.status(201).json({
      success: true,
      message: 'Électeur créé. Email d\'activation envoyé.',
      activationLink,
      voter: { id: newVoterId, matricule, full_name, email: email || null, promotion: promotion || null }
    });
  } catch (error) {
    console.error('Erreur création électeur:', error);
    res.status(500).json({ success: false, message: 'Erreur création électeur', error: error.message });
  }
});

// === Gestion des électeurs par scrutin ===
// Liste complète des électeurs (admin) avec pagination
app.get('/api/voters', authenticateToken, asyncHandler(async (req, res) => {
  if (req.user.type !== 'admin') {
    return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
  }
  
  const search = (req.query.search || '').toString().trim();
  const instId = req.user.institution_id || null;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  // Requête pour le total
  let countSql = 'SELECT COUNT(*) as total FROM voters WHERE 1=1';
  let dataSql = 'SELECT id, matricule, full_name, email, promotion, is_active, activation_token, activation_expires FROM voters WHERE 1=1';
  const params = [];
  
  if (instId) { 
    countSql += ' AND institution_id = ?';
    dataSql += ' AND institution_id = ?';
    params.push(instId); 
  }
  
  if (search) {
    const searchParam = `%${search}%`;
    countSql += ' AND (matricule LIKE ? OR full_name LIKE ? OR email LIKE ? OR promotion LIKE ?)';
    dataSql += ' AND (matricule LIKE ? OR full_name LIKE ? OR email LIKE ? OR promotion LIKE ?)';
    params.push(searchParam, searchParam, searchParam, searchParam);
  }
  
  dataSql += ' ORDER BY promotion, matricule';
  const countParams = params.slice();
  const dataParams = [...params];
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 50;
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const finalDataSql = `${dataSql} LIMIT ${safeLimit} OFFSET ${safeOffset}`;

  const [[countResult]] = await pool.execute(countSql, countParams);
  const total = countResult.total;
  const [voters] = await pool.execute(finalDataSql, dataParams);

  res.json({ 
    success: true, 
    voters,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1
    }
  });
}));

// Renvoyer l'email d'activation à un électeur (admin)
app.post('/api/voters/:id/resend-activation', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success:false, message:'Accès réservé aux administrateurs' });
    const voterId = Number(req.params.id);
    const [[v]] = await pool.execute('SELECT v.id, v.email, v.activation_token, v.full_name, i.name AS institution_name FROM voters v LEFT JOIN institutions i ON i.id = v.institution_id WHERE v.id = ? LIMIT 1', [voterId]);
    if (!v) return res.status(404).json({ success:false, message:'Électeur introuvable' });
    if (!v.email) return res.status(400).json({ success:false, message:'Aucun email pour cet électeur' });
    const token = v.activation_token || crypto.randomBytes(24).toString('hex');
    if (!v.activation_token) {
      const expires = new Date(Date.now() + 1000*60*60*24*3);
      await pool.execute('UPDATE voters SET activation_token = ?, activation_expires = ? WHERE id = ?', [token, expires, voterId]);
    }
    if (mailTransporter) {
      const activationLink = `${process.env.FRONTEND_URL || 'http://localhost:8080'}/activate/${token}`;
      const html = buildActivationEmailHTML(activationLink, process.env.FRONTEND_URL || 'http://localhost:8080', { recipientName: v.full_name, institutionName: v.institution_name });
      await mailTransporter.sendMail({ to: v.email, from: MAIL_FROM, subject: 'VOTUX – Activez votre compte', html, text: `Activez votre compte: ${activationLink}` });
    }
    res.json({ success:true, message:'Email renvoyé' });
  } catch (e) {
    res.status(500).json({ success:false, message:'Erreur renvoi activation', error:e.message });
  }
});

// Activer manuellement un électeur (admin)
app.post('/api/voters/:id/activate', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') return res.status(403).json({ success:false, message:'Accès réservé aux administrateurs' });
    const voterId = Number(req.params.id);
    await pool.execute('UPDATE voters SET is_active = 1, activation_token = NULL, activation_expires = NULL WHERE id = ?', [voterId]);
    res.json({ success:true, message:'Électeur activé' });
  } catch (e) {
    res.status(500).json({ success:false, message:'Erreur activation', error:e.message });
  }
});

// Liste des électeurs éligibles pour un scrutin (admin)
app.get('/api/elections/:id/eligible-voters', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const electionId = req.params.id;
    // Enforce institution scope
    if (!(await assertAdminCanAccessElection(req, res, electionId))) return;
    const [rows] = await pool.execute(
      `SELECT v.id, v.matricule, v.full_name, v.email, v.promotion, vr.has_voted, vr.voted_at
       FROM voting_records vr
       JOIN voters v ON v.id = vr.voter_id
       WHERE vr.election_id = ?
       ORDER BY v.promotion, v.matricule`,
      [electionId]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur liste éligibles', error: error.message });
  }
});

// Ajouter des électeurs éligibles à un scrutin (admin)
app.post('/api/elections/:id/eligible-voters', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const electionId = req.params.id;
    // Enforce institution scope
    if (!(await assertAdminCanAccessElection(req, res, electionId))) return;
    const { voterIds } = req.body;
    if (!Array.isArray(voterIds) || voterIds.length === 0) {
      return res.status(400).json({ success: false, message: 'voterIds requis' });
    }
    for (const voterId of voterIds) {
      await pool.execute(
        'INSERT IGNORE INTO voting_records (voter_id, election_id, has_voted) VALUES (?, ?, FALSE)',
        [voterId, electionId]
      );
    }
    res.json({ success: true, message: 'Électeurs ajoutés' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur ajout éligibles', error: error.message });
  }
});

// Retirer l'éligibilité d'un électeur (admin) si pas encore voté
app.delete('/api/elections/:id/eligible-voters/:voterId', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const electionId = req.params.id;
    const voterId = req.params.voterId;
    // Ne pas supprimer si déjà voté
    const [rows] = await pool.execute(
      'SELECT has_voted FROM voting_records WHERE voter_id = ? AND election_id = ?',
      [voterId, electionId]
    );
    if (rows.length > 0 && rows[0].has_voted) {
      return res.status(400).json({ success: false, message: 'Impossible de retirer: électeur a déjà voté' });
    }
    await pool.execute(
      'DELETE FROM voting_records WHERE voter_id = ? AND election_id = ?',
      [voterId, electionId]
    );
    res.json({ success: true, message: 'Électeur retiré' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur retrait éligible', error: error.message });
  }
});

// Route de test MySQL
app.get('/api/test-db', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Connexion MySQL réussie!');
    connection.release();
    
    res.json({ 
      success: true, 
      message: '✅ Base de données connectée',
      database: 'MySQL VOTUX'
    });
  } catch (error) {
    console.error('❌ Erreur MySQL:', error.message);
    res.status(500).json({ 
      success: false, 
      message: '❌ Base de données non accessible',
      error: error.message 
    });
  }
});

// Route pour lister les administrateurs
app.get('/api/admins', async (req, res) => {
  try {
    const [admins] = await pool.execute('SELECT id, email, full_name, role FROM administrators');
    
    res.json({
      success: true,
      data: admins,
      count: admins.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des administrateurs',
      error: error.message
    });
  }
});

// Route de login
app.post('/api/auth/login', loginLimiter, asyncHandler(async (req, res) => {
  try {
    const { matricule, password } = req.body;
    
    if (!matricule || !password) {
      return res.status(400).json({
        success: false,
        message: 'Matricule/email et mot de passe requis'
      });
    }

    const result = await authenticateUser(matricule, password, pool);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(401).json(result);
    }
  } catch (error) {
    // L'erreur sera gérée par le middleware errorHandler
    throw error;
  }
}));

// Middleware de gestion d'erreurs (doit être le dernier middleware)
app.use(errorHandler);

// Démarrer le serveur
app.listen(PORT, () => {
  console.log('🎉 VOTUX BACKEND DÉMARRÉ');
  console.log(`📍 Port: ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/api/health`);
  console.log(`🗄️  DB Test: http://localhost:${PORT}/api/test-db`);
  console.log(`🔐 Login: POST http://localhost:${PORT}/api/auth/login`);
});

// Migration légère: ajouter elections.institution_id et le renseigner depuis administrators.institution_id
async function ensureElectionInstitutionColumn() {
  try {
    await pool.execute('ALTER TABLE elections ADD COLUMN institution_id INT NULL');
  } catch (e) {
    const msg = (e?.message || '').toLowerCase();
    if (!msg.includes('duplicate') && !msg.includes('exists')) {
      console.warn('⚠️  ALTER elections ADD institution_id:', e.message);
    }
  }
  try {
    await pool.execute(`
      UPDATE elections e
      JOIN administrators a ON a.id = e.created_by
      SET e.institution_id = a.institution_id
      WHERE e.institution_id IS NULL
    `);
  } catch (e) {
    console.warn('⚠️  Backfill elections.institution_id:', e.message);
  }
}
ensureElectionInstitutionColumn();

// Route pour créer un scrutin (admin seulement)
app.post('/api/elections', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès réservé aux administrateurs'
      });
    }

    const { title, description, start_date, end_date, is_public, max_votes, candidates } = req.body;

    if (!title || !start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'Titre, date de début et date de fin sont requis'
      });
    }

    // Créer l'élection
    const [result] = await pool.execute(
      'INSERT INTO elections (title, description, start_date, end_date, is_public, max_votes, created_by, status, institution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, description, start_date, end_date, is_public || false, max_votes || 1, req.user.id, 'draft', req.user.institution_id || null]
    );

    const electionId = result.insertId;

    // Ajouter les candidats si fournis
    if (candidates && candidates.length > 0) {
      for (const candidate of candidates) {
        await pool.execute(
          'INSERT INTO candidates (election_id, name, description, order_position) VALUES (?, ?, ?, ?)',
          [electionId, candidate.name, candidate.description, candidate.order_position || candidate.order || 0]
        );
      }
    }

    res.json({
      success: true,
      message: 'Scrutin créé avec succès',
      electionId: electionId
    });

  } catch (error) {
    console.error('Erreur création scrutin:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création du scrutin',
      error: error.message
    });
  }
});

// Route pour lister les scrutins (retourne un tableau simple)
app.get('/api/elections', authenticateToken, async (req, res) => {
  try {
    // Ensure 'archived' column exists
    try { await pool.execute('ALTER TABLE elections ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0'); } catch {}

    let electionsQuery;
    let params = [];
    if (req.user?.type === 'admin') {
      // Admin: allow seeing archived via query (?archived=0/1/all). Default 0.
      const arch = (req.query.archived || '0').toString();
      const whereArchived = arch === 'all' ? '' : ' AND e.archived = ?';
      const archivedParam = arch === 'all' ? [] : [arch === '1' ? 1 : 0];
      if (!req.user.institution_id) {
        return res.status(403).json({ success: false, message: 'Administrateur non rattaché à une institution' });
      }
      electionsQuery = `
        SELECT e.*, a.full_name as created_by_name 
        FROM elections e 
        LEFT JOIN administrators a ON e.created_by = a.id 
        WHERE e.institution_id = ?
        ${whereArchived}
        ORDER BY e.created_at DESC
      `;
      params = [req.user.institution_id, ...archivedParam];
    } else {
      // Pour un électeur: ne retourner que les scrutins où il est éligible
      electionsQuery = `
        SELECT e.*, a.full_name as created_by_name 
        FROM elections e 
        JOIN voting_records vr ON vr.election_id = e.id AND vr.voter_id = ?
        LEFT JOIN administrators a ON e.created_by = a.id 
        WHERE e.archived = 0
        ORDER BY e.created_at DESC
      `;
      params = [req.user.id];
    }

    const [elections] = await pool.execute(electionsQuery, params);

    // Normaliser les statuts pour le front
    const normalized = elections.map((e) => {
      let status = e.status;
      if (!status || status === '') status = 'pending';
      if (status === 'draft') status = 'pending';
      if (status === 'active') status = 'ongoing';
      if (status === 'completed') status = 'closed';
      return { ...e, status };
    });

    // Pour chaque élection, récupérer les candidats
    const electionsWithCandidates = await Promise.all(
      normalized.map(async (election) => {
        const [candidates] = await pool.execute(
          'SELECT * FROM candidates WHERE election_id = ? ORDER BY order_position',
          [election.id]
        );
        return { ...election, candidates };
      })
    );

    res.json(electionsWithCandidates);

  } catch (error) {
    console.error('Erreur liste scrutins:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des scrutins',
      error: error.message
    });
  }
});

// Route pour lister les candidats d'un scrutin
app.get('/api/elections/:id/candidates', authenticateToken, async (req, res) => {
  try {
    const electionId = req.params.id;
    // If admin, enforce institution check
    if (req.user?.type === 'admin') {
      const ok = await assertAdminCanAccessElection(req, res, electionId);
      if (!ok) return; // response already sent
    }
    const [candidates] = await pool.execute(
      'SELECT * FROM candidates WHERE election_id = ? ORDER BY order_position',
      [electionId]
    );

    res.json(candidates);

  } catch (error) {
    console.error('Erreur liste candidats:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des candidats',
      error: error.message
    });
  }
});

// Route pour démarrer un scrutin (status -> ongoing)
app.post('/api/elections/:id/start', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès réservé aux administrateurs'
      });
    }

    const electionId = req.params.id;
    if (!(await assertAdminCanAccessElection(req, res, electionId))) return;

    // Vérifier que l'élection existe
    const [elections] = await pool.execute(
      'SELECT * FROM elections WHERE id = ?',
      [electionId]
    );

    if (elections.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Scrutin non trouvé'
      });
    }

    // Mettre à jour le statut depuis '', 'draft', 'pending' -> 'ongoing'
    const [result] = await pool.execute(
      'UPDATE elections SET status = ? WHERE id = ?',
      ['active', electionId]
    );
    console.log('📣 START election', { electionId, by: req.user?.id, affectedRows: result?.affectedRows });
    const [[updated]] = await pool.execute('SELECT id, status, start_date, end_date FROM elections WHERE id = ?', [electionId]);
    res.json({ success: true, message: 'Scrutin démarré avec succès', election: updated });

  } catch (error) {
    console.error('Erreur démarrage scrutin:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du démarrage du scrutin',
      error: error.message
    });
  }
});

// Route pour voter
app.post('/api/vote', voteLimiter, authenticateToken, asyncHandler(async (req, res) => {
  try {
    const { electionId, candidateId } = req.body;
    const voterId = req.user.id;

    if (!electionId || !candidateId) {
      return res.status(400).json({
        success: false,
        message: 'ID du scrutin et du candidat requis'
      });
    }

    // Vérifier l'éligibilité (doit exister une ligne dans voting_records)
    const [votingRecords] = await pool.execute(
      'SELECT * FROM voting_records WHERE voter_id = ? AND election_id = ?',
      [voterId, electionId]
    );
    if (votingRecords.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Vous n\'êtes pas éligible à ce scrutin'
      });
    }
    if (votingRecords[0].has_voted) {
      return res.status(400).json({
        success: false,
        message: 'Vous avez déjà voté pour ce scrutin'
      });
    }

    // Vérifier que le scrutin est actif (ongoing ou active)
    const [elections] = await pool.execute(
      "SELECT * FROM elections WHERE id = ? AND (status = 'ongoing' OR status = 'active')",
      [electionId]
    );

    if (elections.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Scrutin non trouvé ou non actif'
      });
    }

    // Vérifier que le candidat existe
    const [candidates] = await pool.execute(
      'SELECT * FROM candidates WHERE id = ? AND election_id = ?',
      [candidateId, electionId]
    );

    if (candidates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Candidat non valide pour ce scrutin'
      });
    }

    // Préparer le vote pour chiffrement
    const voteData = {
      electionId: electionId.toString(),
      candidateId: candidateId.toString(),
      timestamp: new Date().toISOString()
    };

    // Chiffrer le vote
    const encryptedVote = VoteEncryption.encryptVote(voteData, electionId.toString());
    
    // Générer un hash unique pour le vote
    const voteHash = VoteEncryption.generateVoteHash(
      voterId.toString(), 
      electionId.toString(), 
      voteData.timestamp
    );

    // Stocker dans MongoDB (urne électronique)
    const ballot = new Ballot({
      electionId: electionId.toString(),
      encryptedVote: JSON.stringify(encryptedVote),
      voteHash: voteHash
    });

    await ballot.save();

    // Marquer l'électeur comme ayant voté (MySQL)
    await pool.execute(
      'UPDATE voting_records SET has_voted = TRUE, voted_at = NOW() WHERE voter_id = ? AND election_id = ?',
      [voterId, electionId]
    );

    res.json({
      success: true,
      message: 'Vote enregistré avec succès',
      receipt: voteHash // Preuve de vote (anonyme)
    });

  } catch (error) {
    // L'erreur sera gérée par le middleware errorHandler
    throw error;
  }
}));

// Route de dépouillement (admin seulement)
app.post('/api/elections/:id/tally', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Accès réservé aux administrateurs'
      });
    }

    const electionId = req.params.id;
    const { decryptionKey } = req.body || {};
    // La clé est optionnelle pour l'instant: on procède même si elle n'est pas fournie

    // Récupérer tous les bulletins de cette élection
    const ballots = await Ballot.find({ electionId: electionId.toString() });
    
    console.log(`🗳️  Dépouillement: ${ballots.length} bulletins trouvés`);

    // Vérifier la cohérence avec MySQL
    const [votingRecords] = await pool.execute(
      'SELECT COUNT(*) as voteCount FROM voting_records WHERE election_id = ? AND has_voted = TRUE',
      [electionId]
    );

    const mysqlVoteCount = votingRecords[0].voteCount;
    const mongoVoteCount = ballots.length;

    if (mysqlVoteCount !== mongoVoteCount) {
      return res.status(500).json({
        success: false,
        message: 'Incohérence détectée entre MySQL et MongoDB',
        details: {
          mysqlVotes: mysqlVoteCount,
          mongoVotes: mongoVoteCount
        }
      });
    }

    // Déchiffrer et compter les votes
    const voteCount = {};
    let decryptedCount = 0;

    for (const ballot of ballots) {
      try {
        const encryptedData = JSON.parse(ballot.encryptedVote);
        const voteData = VoteEncryption.decryptVote(
          encryptedData.encryptedData,
          electionId.toString(),
          encryptedData.iv,
          encryptedData.authTag
        );

        const candidateId = voteData.candidateId;
        voteCount[candidateId] = (voteCount[candidateId] || 0) + 1;
        decryptedCount++;

      } catch (decryptError) {
        console.error('❌ Erreur déchiffrement bulletin:', decryptError);
      }
    }

    // Récupérer les noms des candidats
    const [candidates] = await pool.execute(
      'SELECT id, name FROM candidates WHERE election_id = ?',
      [electionId]
    );

    const candidateMap = {};
    candidates.forEach(candidate => {
      candidateMap[candidate.id] = candidate.name;
    });

    // Préparer les résultats
    const results = Object.keys(voteCount).map(candidateId => ({
      candidateId: candidateId,
      candidateName: candidateMap[candidateId] || 'Candidat inconnu',
      votes: voteCount[candidateId],
      percentage: ((voteCount[candidateId] / ballots.length) * 100).toFixed(2)
    }));

    // Trier par nombre de votes (décroissant)
    results.sort((a, b) => b.votes - a.votes);

    // Déterminer vainqueur et égalités
    const topVotes = results.length > 0 ? results[0].votes : 0;
    const tiedCandidates = results.filter(r => r.votes === topVotes);
    const tie = tiedCandidates.length > 1 && topVotes > 0;
    const winner = tie ? null : (results[0] || null);

    // Persister un résumé en MySQL (table election_results)
    try {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS election_results (
          id INT PRIMARY KEY AUTO_INCREMENT,
          election_id INT UNIQUE,
          total_votes INT DEFAULT 0,
          results_json JSON,
          proclaimed TINYINT(1) DEFAULT 0,
          proclaimed_at TIMESTAMP NULL,
          winner_id INT NULL,
          winner_name VARCHAR(255) NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      const doUpsert = async () => {
        await pool.execute(
          `INSERT INTO election_results (election_id, total_votes, results_json, winner_id, winner_name)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE total_votes = VALUES(total_votes), results_json = VALUES(results_json), winner_id = VALUES(winner_id), winner_name = VALUES(winner_name)`,
          [electionId, ballots.length, JSON.stringify({ list: results, tie, tiedCandidates }), winner ? parseInt(winner.candidateId, 10) : null, winner ? winner.candidateName : null]
        );
      };

      try {
        await doUpsert();
      } catch (upErr) {
        const msg = (upErr?.message || '').toLowerCase();
        if (msg.includes('unknown column') && (msg.includes('winner_id') || msg.includes('winner_name') || msg.includes('proclaimed'))) {
          console.warn('⚠️  Colonnes manquantes dans election_results, tentative de migration…');
          try {
            await pool.execute('ALTER TABLE election_results ADD COLUMN winner_id INT NULL');
          } catch {}
          try {
            await pool.execute('ALTER TABLE election_results ADD COLUMN winner_name VARCHAR(255) NULL');
          } catch {}
          try {
            await pool.execute('ALTER TABLE election_results ADD COLUMN proclaimed TINYINT(1) DEFAULT 0');
          } catch {}
          try {
            await pool.execute('ALTER TABLE election_results ADD COLUMN proclaimed_at TIMESTAMP NULL');
          } catch {}
          await doUpsert();
          console.log('✅ Migration election_results OK, upsert rejoué');
        } else {
          throw upErr;
        }
      }
    } catch (persistErr) {
      console.warn('⚠️  Persistance des résultats échouée:', persistErr.message);
    }

    res.json({
      success: true,
      message: 'Dépouillement terminé avec succès',
      electionId: electionId,
      summary: {
        totalVotes: ballots.length,
        decryptedVotes: decryptedCount,
        failedDecryptions: ballots.length - decryptedCount
      },
      consistency: {
        mysqlVotes: mysqlVoteCount,
        mongoVotes: mongoVoteCount,
        status: mysqlVoteCount === mongoVoteCount ? '✅ COHÉRENT' : '❌ INCOHÉRENT'
      },
      results: results,
      tie,
      tiedCandidates,
      winner: winner
    });

  } catch (error) {
    console.error('Erreur dépouillement:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du dépouillement',
      error: error.message
    });
  }
});

// Lecture des résultats persistés (admin ou électeur connecté selon besoin)
app.get('/api/elections/:id/results', authenticateToken, async (req, res) => {
  try {
    const electionId = req.params.id;
    // If admin, enforce institution scope
    if (req.user?.type === 'admin' && req.user?.institution_id) {
      if (!(await assertAdminCanAccessElection(req, res, electionId))) return;
    }
    // Table créée lors du tally si inexistante
    const [rows] = await pool.execute(
      'SELECT total_votes, results_json, proclaimed, proclaimed_at, winner_id, winner_name, updated_at FROM election_results WHERE election_id = ?',[electionId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Aucun résultat disponible pour ce scrutin' });
    }
    // Short private cache to reduce repeated load while keeping auth-only visibility
    res.set('Cache-Control', 'private, max-age=30');
    res.json({
      success: true,
      electionId,
      totalVotes: rows[0].total_votes,
      results: rows[0].results_json,
      proclaimed: rows[0].proclaimed === 1,
      proclaimedAt: rows[0].proclaimed_at,
      winner: rows[0].winner_id ? { id: rows[0].winner_id, name: rows[0].winner_name } : null,
      updatedAt: rows[0].updated_at
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur lecture résultats', error: error.message });
  }
});

// Proclamation officielle des résultats
app.post('/api/elections/:id/proclaim', authenticateToken, async (req, res) => {
  try {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
    }
    const electionId = req.params.id;
    if (!(await assertAdminCanAccessElection(req, res, electionId))) return;
    const [rows] = await pool.execute('SELECT results_json, winner_id, winner_name FROM election_results WHERE election_id = ?', [electionId]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Aucun résultat à proclamer' });
    await pool.execute('UPDATE election_results SET proclaimed = 1, proclaimed_at = NOW() WHERE election_id = ?', [electionId]);
    const [[after]] = await pool.execute('SELECT total_votes, results_json, proclaimed, proclaimed_at, winner_id, winner_name, updated_at FROM election_results WHERE election_id = ?', [electionId]);
    res.json({
      success: true,
      message: 'Résultats proclamés',
      electionId,
      proclaimed: after.proclaimed === 1,
      proclaimedAt: after.proclaimed_at,
      winner: after.winner_id ? { id: after.winner_id, name: after.winner_name } : null
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erreur proclamation', error: error.message });
  }
});