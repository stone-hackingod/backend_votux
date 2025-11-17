-- Création de la base de données VOTUX
CREATE DATABASE IF NOT EXISTS votux CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE votux;

-- Table des administrateurs
CREATE TABLE administrators (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role ENUM('super_admin', 'admin') DEFAULT 'admin',
  is_active BOOLEAN DEFAULT TRUE,
  last_login DATETIME,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Table des électeurs
CREATE TABLE voters (
  id INT PRIMARY KEY AUTO_INCREMENT,
  matricule VARCHAR(20) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150),
  promotion VARCHAR(50),
  faculty VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_matricule (matricule),
  INDEX idx_promotion (promotion)
);

-- Table des scrutins
CREATE TABLE elections (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  start_date DATETIME NOT NULL,
  end_date DATETIME NOT NULL,
  status ENUM('draft', 'active', 'completed', 'cancelled') DEFAULT 'draft',
  created_by INT,
  is_public BOOLEAN DEFAULT FALSE,
  max_votes INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES administrators(id),
  INDEX idx_status (status),
  INDEX idx_dates (start_date, end_date)
);

-- Table des candidats
CREATE TABLE candidates (
  id INT PRIMARY KEY AUTO_INCREMENT,
  election_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  photo_url VARCHAR(255),
  order_position INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE,
  INDEX idx_election (election_id)
);

-- Table d'émargement (qui a voté à quel scrutin)
CREATE TABLE voting_records (
  id INT PRIMARY KEY AUTO_INCREMENT,
  voter_id INT NOT NULL,
  election_id INT NOT NULL,
  has_voted BOOLEAN DEFAULT FALSE,
  voted_at DATETIME,
  session_token TEXT,
  ip_address VARCHAR(45),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (voter_id) REFERENCES voters(id),
  FOREIGN KEY (election_id) REFERENCES elections(id),
  UNIQUE KEY unique_vote (voter_id, election_id),
  INDEX idx_voter_election (voter_id, election_id),
  INDEX idx_has_voted (has_voted)
);

-- Insertion des données de test

-- Administrateur par défaut (mot de passe: "password")
INSERT INTO administrators (email, password_hash, full_name, role) 
VALUES ('bayanistone@gmail.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Administrateur VOTUX', 'super_admin');

-- Électeurs de test (mot de passe: "password" pour tous)
INSERT INTO voters (matricule, password_hash, full_name, email, promotion) VALUES
('ETU001', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Jean Dupont', 'jean.dupont@edu.univ.fr', 'L2 Informatique'),
('ETU002', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Marie Martin', 'marie.martin@edu.univ.fr', 'L2 Informatique'),
('ETU003', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Pierre Durand', 'pierre.durand@edu.univ.fr', 'M1 Mathématiques'),
('ETU004', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Sophie Lambert', 'sophie.lambert@edu.univ.fr', 'L2 Informatique'),
('ETU005', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Thomas Moreau', 'thomas.moreau@edu.univ.fr', 'M1 Mathématiques');

-- Scrutin de test
INSERT INTO elections (title, description, start_date, end_date, status, created_by, is_public, max_votes) 
VALUES (
  'Élection Délégués L2 Informatique 2024',
  'Élection des délégués de promotion pour la Licence 2 Informatique - Année académique 2024/2025',
  '2024-01-20 08:00:00',
  '2024-01-25 18:00:00',
  'active',
  1,
  TRUE,
  1
);

-- Candidats pour le scrutin
INSERT INTO candidates (election_id, name, description, order_position) VALUES
(1, 'Marie Martin', 'Candidate engagée pour la vie étudiante - Projet: Améliorer les espaces de travail', 1),
(1, 'Pierre Durand', 'Expérience en représentation étudiante - Projet: Plus d''événements universitaires', 2),
(1, 'Lucie Petit', 'Nouvelle perspective - Projet: Amélioration de la communication', 3),
(1, 'Vote Blanc', 'Exprimer son désaccord avec les candidats proposés', 4);

-- Afficher les données insérées
SELECT '=== ADMINISTRATEURS ===' as '';
SELECT * FROM administrators;

SELECT '=== ÉLECTEURS ===' as '';
SELECT matricule, full_name, email, promotion FROM voters;

SELECT '=== SCRUTINS ===' as '';
SELECT * FROM elections;

SELECT '=== CANDIDATS ===' as '';
SELECT * FROM candidates;