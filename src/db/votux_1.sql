USE votux_1;

CREATE TABLE IF NOT EXISTS administrators (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS elections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  start_date DATETIME NULL,
  end_date DATETIME NULL,
  status ENUM('pending','active','ongoing','closed') DEFAULT 'pending',
  is_public TINYINT(1) DEFAULT 0,
  max_votes INT DEFAULT 1,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_elections_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS candidates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  election_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  order_position INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_candidates_election (election_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS voters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  matricule VARCHAR(100) UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  promotion VARCHAR(100),
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS voting_records (
  voter_id INT NOT NULL,
  election_id INT NOT NULL,
  has_voted TINYINT(1) DEFAULT 0,
  voted_at DATETIME NULL,
  PRIMARY KEY (voter_id, election_id),
  INDEX idx_vr_election (election_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS election_results (
  id INT AUTO_INCREMENT PRIMARY KEY,
  election_id INT UNIQUE,
  total_votes INT DEFAULT 0,
  results_json JSON,
  proclaimed TINYINT(1) DEFAULT 0,
  proclaimed_at TIMESTAMP NULL,
  winner_id INT NULL,
  winner_name VARCHAR(255) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;