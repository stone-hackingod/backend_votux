# 🗳️ VOTUX - Backend

Système de vote électronique sécurisé et anonyme pour institutions universitaires.

## 📋 Description

Backend du projet VOTUX offrant une API RESTful sécurisée pour la gestion des scrutins électroniques. Le système garantit l'anonymat des votes grâce à une architecture hybride MySQL/MongoDB.

## 🏗️ Architecture

```
Frontend (React) ←→ Backend (Node.js/Express) ←→ Bases de Données
                                         ├── MySQL (Données structurées)
                                         │   ├── voters (électeurs)
                                         │   ├── elections (scrutins)
                                         │   ├── candidates (candidats)
                                         │   └── voting_records (émargement)
                                         │
                                         └── MongoDB (Données anonymes)
                                             └── ballots (votes chiffrés)
```

## 🚀 Installation

### Prérequis
- Node.js 18+
- MySQL 8.0+
- MongoDB 6.0+

### Configuration

1. **Cloner le projet**
```bash
git clone [url-du-projet]
cd votux/backend
```

2. **Installer les dépendances**
```bash
npm install
```

3. **Configuration de l'environnement**
```bash
cp .env.example .env
```
Éditez le fichier `.env` :
```env
# Serveur
NODE_ENV=production
FRONTEND_URL=https://votux.vercel.app/
FRONTEND_URLS=https://votux.vercel.app/

# MySQL (Aiven)
MYSQL_HOST=your-mysql-host.aivencloud.com
MYSQL_PORT=12345
MYSQL_DATABASE=your_database
MYSQL_USER=your_username
MYSQL_PASSWORD=your_secure_password
MYSQL_SSL=true
MYSQL_REJECT_UNAUTHORIZED=true
MYSQL_CONNECT_TIMEOUT=30000
MYSQL_SSL_CA=your_ssl_ca_content_here
# OU utiliser MYSQL_SSL_CA_B64 pour une version encodée en base64
# MYSQL_SSL_CA_B64=base64_encoded_ssl_ca_here

# MongoDB (Atlas)
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/your_database?retryWrites=true&w=majority

# Sécurité
JWT_SECRET=your_secure_jwt_secret
JWT_EXPIRES_IN=24h
ENCRYPTION_KEY=your_secure_encryption_key

# SMTP (Brevo)
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your_brevo_username
SMTP_PASS=your_brevo_password
MAIL_FROM="Your App Name <your-email@example.com>"
```

4. **Initialiser la base de données**
```sql
-- Exécuter le script SQL fourni pour créer le schéma et les données d'exemple
mysql -u root -p < src/db/votux_final.sql
```

5. **Démarrer le serveur**
```bash
# Développement
npm run dev

# Production
npm start
```

## 👤 Créer un administrateur (Admin)

Deux façons rapides. L’admin se connecte via `POST /api/auth/login` en utilisant son email dans le champ `matricule` (côté backend, les admins sont recherchés par email).

- Exemple login admin:
  ```json
  {
    "matricule": "admin@example.com",
    "password": "motdepasse"
  }
  ```

### Option A — SQL direct (recommandé en initialisation)
1) Calculer le hash bcrypt du mot de passe (coût 10):
```bash
node -e "console.log(require('bcryptjs').hashSync('motdepasse', 10))"
```
Note: remplace `motdepasse` par le mot de passe voulu et copie le hash affiché.

2) S’assurer que l’institution existe (ex: INPTIC) et récupérer son id:
```sql
INSERT INTO institutions (name, code, public_voters_enabled)
VALUES ('INPTIC','INPTIC',0)
ON DUPLICATE KEY UPDATE name = name;

-- Récupérer l'id (notez la valeur retournée)
SELECT id FROM institutions WHERE code = 'INPTIC';
```

3) Créer l’admin rattaché à l’institution (remplacez `<HASH_BCRYPT>` et `<INSTITUTION_ID>`):
```sql
INSERT INTO administrators (email, full_name, role, password_hash, is_active, institution_id)
VALUES ('admin@example.com', 'Admin INPTIC', 'admin', '<HASH_BCRYPT>', 1, <INSTITUTION_ID>);
```

### Option B — Mettre à jour un admin existant
```sql
UPDATE administrators
SET password_hash = '<HASH_BCRYPT>', is_active = 1, institution_id = <INSTITUTION_ID>
WHERE email = 'admin@example.com';
```

Après connexion, le token JWT de l’admin inclut `institution_id` et le backend restreint l’accès aux ressources de son institution uniquement.

## 📡 API Endpoints

### Authentification
- `POST /api/auth/login` - Connexion électeur/administrateur (réponse inclut `user.isAdmin` et `user.type`)
- `GET /api/auth/profile` - Profil utilisateur (protégé)
- `POST /api/auth/activate` - Activation de compte via lien email (`{ token, password }`)

### Gestion des Scrutins (Admin)
- `POST /api/elections` - Créer un scrutin (`status` initial: `draft`)
- `GET /api/elections?archived=0|1|all` - Lister tous les scrutins (inclut `candidates`, filtre d'archivage côté admin)
- `GET /api/elections/:id/candidates` - Lister les candidats d'un scrutin
- `POST /api/elections/:id/start` - Démarrer un scrutin (passe `status` à `active`)
- `POST /api/elections/:id/tally` - Dépouiller un scrutin
- `GET /api/elections/:id/results` - Lire les résultats persistés
- `POST /api/elections/:id/proclaim` - Proclamer les résultats
- `POST /api/elections/:id/archive` - Archiver le scrutin
- `POST /api/elections/:id/unarchive` - Désarchiver le scrutin

### Gestion des égalités (Admin)
- Détection automatique d'égalité parfaite en tête lors du dépouillement (`/api/elections/:id/tally`)
- `POST /api/elections/:id/tie-break` avec body:
  - `{ action: 'second_round', candidateIds: number[] }` → crée un second tour (nouveau scrutin) avec les seuls ex‑aequo
  - `{ action: 'random_draw', candidateIds: number[] }` → tirage au sort (seed/index journalisés), définit le gagnant
  - `{ action: 'regulatory_decision', chosenCandidateId: number, note?: string }` → choix manuel selon le protocole

### Liste électorale publique
- `POST /api/elections/:id/publish-voters-list` (admin) → publier/dépublier la liste publique d'un scrutin `{ published: boolean }`
- `GET /api/elections/:id/public-voters` (public) → retourne la liste publique si publiée

### Vote
- `POST /api/vote` - Soumettre un vote (nécessite que l'électeur soit éligible via `voting_records` et que le scrutin soit `active`)

### Administration
- `GET /api/admins` - Lister les administrateurs
- `GET /api/voters` - Lister les électeurs
- `POST /api/voters` - Créer un électeur (admin)
  - Body requis: `matricule`, `full_name`, `password`
  - Optionnels: `email`, `promotion`, `assignElectionId` (affecte au scrutin)
- `GET /api/elections/:id/eligible-voters` - Lister les électeurs affectés au scrutin
- `POST /api/elections/:id/eligible-voters` - Affecter des électeurs au scrutin (body `{ voterIds: number[] }`)
- `DELETE /api/elections/:id/eligible-voters/:voterId` - Retirer un électeur (si non voté)

## 🔐 Sécurité

### Mesures implémentées
- **JWT** pour l'authentification
- **BCrypt** pour le hachage des mots de passe
- **AES-256-GCM** pour le chiffrement des votes
- **Séparation physique** MySQL/MongoDB pour l'anonymat
- **Validation des données** côté serveur (contrôles d'entrée et normalisation)
- **Rate limiting** sur les endpoints critiques
- **CORS** configuré restrictivement

### Protocole de vote
1. Authentification de l'électeur
2. Vérification de l'éligibilité (MySQL)
3. Chiffrement du vote (AES-256)
4. Stockage anonyme (MongoDB)
5. Marquage comme ayant voté (MySQL)
6. Dépouillement et persistage d'un résumé en MySQL (`election_results`)

### Format des résultats (persistés)
`GET /api/elections/:id/results` → `results` peut être:
- Ancien format: tableau de lignes `{ candidateId, candidateName, votes, percentage }`
- Nouveau format: objet `{ list: ResultRow[], tie: boolean, tiedCandidates: ResultRow[] }`
  - En cas d'égalité (`tie = true`), `winner` est `null` jusqu'à résolution via tie-break.

## 🗃️ Modèles de Données

### MySQL Schema
```sql
-- Électeurs
voters(id, matricule, password_hash, full_name, email, promotion, is_active)

-- Scrutins  
elections(id, title, description, start_date, end_date, status, created_by)

-- Candidats
candidates(id, election_id, name, description, order_position)

-- Émargement
voting_records(id, voter_id, election_id, has_voted, voted_at)
```

### MongoDB Schema
```javascript
// Bulletins de vote
{
  electionId: String,
  encryptedVote: String, // Vote chiffré
  voteHash: String,      // Hash unique
  timestamp: Date
}
```

## 🧪 Tests

### Données de test
**Administrateur par défaut :**
- Email: `bayanistone@gmail.com`
- Mot de passe: `password`

**Électeurs de test :**
- Matricule: `ETU001`, `ETU002`, `ETU003`
- Mot de passe: `password`

### Tests manuels avec Postman
1. **Authentification**
```bash
POST http://localhost:3001/api/auth/login
{
  "matricule": "ETU001",
  "password": "password"
}
```

2. **Créer un scrutin** (admin)
```bash
POST http://localhost:3001/api/elections
Authorization: Bearer <token_admin>
{
  "title": "Élection Test",
  "start_date": "2024-01-20 08:00:00",
  "end_date": "2024-01-25 18:00:00",
  "candidates": [...]
}
```

3. **Voter**
```bash
POST http://localhost:3001/api/vote  
Authorization: Bearer <token_electeur>
{
  "electionId": 1,
  "candidateId": 1
}
```

## 🛠️ Développement

### Structure du projet
```
backend/
├── src/
│   ├── config/
│   │   └── database.js          # Configuration MySQL
│   ├── models/
│   │   └── Ballot.js            # Modèle MongoDB
│   ├── utils/
│   │   └── encryption.js        # Chiffrement/déchiffrement
│   ├── auth.js                  # Authentification JWT
│   └── server.js                # Serveur principal
├── database/
│   └── init.sql                 # Script d'initialisation MySQL
├── .env
└── package.json
```

### Scripts disponibles
```bash
npm run dev      # Démarrage en développement
npm start        # Démarrage en production
npm test         # Exécution des tests
```

## 🔍 Monitoring

Le serveur expose un endpoint de santé :
```bash
GET http://localhost:3001/api/health
```

## 👥 Auteurs

- **BAYANI LIYOKO, Jen-Stone Ezéchiel** - Développeur principal

## 📄 Licence

Ce projet est développé dans le cadre d'un projet de fin d'études DTS en Génie Informatique.

### Limitation de débit (Rate limiting)
- Global API: 1000 requêtes / 15 min / IP (sauf /api/health, /api/test-db, OPTIONS)
- Connexion: 20 tentatives / 15 min / IP (les succès ne comptent pas)
- Vote: 60 requêtes / minute / IP (OPTIONS ignorées)
- Import CSV: 30 imports / heure
- Activation: 20 demandes / heure

En production derrière un proxy (Nginx/Cloudflare), activez `app.set('trust proxy', 1)` pour fiabiliser l'IP client.
